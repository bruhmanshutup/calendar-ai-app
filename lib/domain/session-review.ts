import type {
  PlannedSession,
  SessionOutcome,
  SessionReview,
} from "./types";

export function pendingSessionReviews(
  sessions: PlannedSession[],
  now: number,
): PlannedSession[] {
  return sessions
    .filter((session) => {
      if (session.status !== "approved" && session.status !== "in_progress") {
        return false;
      }
      const reviewAt = new Date(session.reviewAfter ?? session.end).getTime();
      return Number.isFinite(reviewAt) && reviewAt <= now;
    })
    .sort((a, b) => new Date(a.end).getTime() - new Date(b.end).getTime());
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
