import type {
  PlannedSession,
  SessionOutcome,
  SessionReview,
} from "./types";

export type SessionCheckInPhase = "in_progress" | "needs_review";

export type SessionCheckIn = {
  session: PlannedSession;
  phase: SessionCheckInPhase;
};

export function sessionCheckIns(
  sessions: PlannedSession[],
  now: number,
): SessionCheckIn[] {
  return sessions
    .filter((session) => {
      if (session.status !== "approved" && session.status !== "in_progress") {
        return false;
      }
      const start = new Date(session.start).getTime();
      const reviewAfter = session.reviewAfter
        ? new Date(session.reviewAfter).getTime()
        : undefined;
      return (
        Number.isFinite(start) &&
        start <= now &&
        (reviewAfter === undefined || reviewAfter <= now)
      );
    })
    .map((session) => ({
      session,
      phase: new Date(session.end).getTime() <= now
        ? "needs_review" as const
        : "in_progress" as const,
    }))
    .sort((a, b) => {
      if (a.phase !== b.phase) return a.phase === "in_progress" ? -1 : 1;
      if (a.phase === "in_progress") {
        return new Date(b.session.start).getTime() - new Date(a.session.start).getTime();
      }
      return new Date(a.session.end).getTime() - new Date(b.session.end).getTime();
    });
}

export function canRecordSessionOutcome(
  checkIn: SessionCheckIn,
  outcome: SessionOutcome,
): boolean {
  return outcome !== "missed" || checkIn.phase === "needs_review";
}

export function createSessionReview(
  session: PlannedSession,
  outcome: SessionOutcome,
  reviewedAt: string,
  minutesCompleted?: number,
): SessionReview {
  const completedMinutes =
    outcome === "completed"
      ? session.minutes
      : outcome === "partial"
        ? Math.round(minutesCompleted ?? 0)
        : 0;

  if (
    outcome === "partial" &&
    (completedMinutes <= 0 || completedMinutes >= session.minutes)
  ) {
    throw new Error(
      `Partial outcomes require between 1 and ${session.minutes - 1} completed minutes.`,
    );
  }

  return {
    id: `review-${session.id}-${new Date(reviewedAt).getTime()}`,
    sessionId: session.id,
    taskId: session.taskId,
    title: session.title,
    scheduledStart: session.start,
    scheduledEnd: session.end,
    outcome,
    plannedMinutes: session.minutes,
    completedMinutes,
    remainingMinutes:
      outcome === "partial" || outcome === "missed"
        ? session.minutes - completedMinutes
        : 0,
    reviewedAt,
  };
}
