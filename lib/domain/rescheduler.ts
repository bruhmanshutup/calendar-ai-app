import { generateSchedule } from "./scheduler";
import type {
  ExistingSession,
  ExtractedTask,
  ReplanProposal,
  SchedulingInput,
} from "./types";

const MINUTE = 60_000;

export type ReplanInput = {
  session: ExistingSession;
  outcome: "missed" | "partial";
  minutesCompleted?: number;
  sessions: ExistingSession[];
  task: ExtractedTask;
  scheduling: Omit<SchedulingInput, "tasks" | "lockedSessions">;
};

export function proposeMinimalReplan(input: ReplanInput): ReplanProposal {
  const originalMinutes = Math.round(
    (new Date(input.session.end).getTime() -
      new Date(input.session.start).getTime()) /
      MINUTE,
  );
  const completed =
    input.outcome === "partial"
      ? Math.max(0, Math.min(originalMinutes, input.minutesCompleted ?? 0))
      : 0;
  const remainingMinutes = originalMinutes - completed;
  const preserved = input.sessions.filter(
    (session) =>
      session.id !== input.session.id &&
      session.status !== "missed" &&
      session.status !== "unnecessary",
  );
  const schedule = generateSchedule({
    ...input.scheduling,
    tasks: [
      {
        ...input.task,
        id: `${input.task.id ?? input.session.taskId}-remaining`,
        title: `${input.task.title} — remaining`,
        estimatedMinutes: remainingMinutes,
        approved: true,
        reviewRequired: false,
        splittable: false,
      },
    ],
    lockedSessions: preserved,
  });
  const replacement = schedule.sessions.find(
    (session) =>
      session.taskId === `${input.task.id ?? input.session.taskId}-remaining`,
  );
  const unschedulable = schedule.unschedulable.find((task) =>
    task.taskId.endsWith("-remaining"),
  );

  if (!replacement) {
    return {
      remainingMinutes,
      changes: [
        {
          type: "remove",
          sessionId: input.session.id,
          before: input.session,
          reason:
            input.outcome === "missed"
              ? "The session was marked missed."
              : `${completed} minutes were completed.`,
        },
      ],
      preservedSessionIds: preserved.map((session) => session.id),
      explanation: `${remainingMinutes} minutes remain, but no valid opening is currently available. No future sessions were moved.`,
      unschedulable,
    };
  }

  replacement.reasonCodes = [
    "MOVED_AFTER_MISSED",
    "STABILITY_PRESERVED",
    ...replacement.reasonCodes.filter(
      (reason) =>
        reason !== "MOVED_AFTER_MISSED" && reason !== "STABILITY_PRESERVED",
    ),
  ];
  replacement.explanation =
    input.outcome === "partial"
      ? `You completed ${completed} of ${originalMinutes} minutes. The remaining ${remainingMinutes} minutes fit here. No other sessions need to move.`
      : "Moved because the earlier session was missed. No other sessions need to move.";

  return {
    remainingMinutes,
    changes: [
      {
        type: "move",
        sessionId: input.session.id,
        before: input.session,
        after: replacement,
        reason: replacement.explanation,
      },
    ],
    preservedSessionIds: preserved.map((session) => session.id),
    explanation: replacement.explanation,
  };
}
