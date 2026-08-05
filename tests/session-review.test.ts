import { describe, expect, it } from "vitest";
import {
  createSessionReview,
  pendingSessionReviews,
} from "../lib/domain/session-review";
import type { PlannedSession } from "../lib/domain/types";

function session(patch: Partial<PlannedSession> = {}): PlannedSession {
  return {
    id: "session-1",
    taskId: "task-1",
    title: "Write report",
    start: "2026-08-05T21:00:00.000Z",
    end: "2026-08-05T22:00:00.000Z",
    minutes: 60,
    status: "approved",
    locked: false,
    reasonCodes: ["PRIORITY"],
    explanation: "Deadline is close.",
    ...patch,
  };
}

describe("session review lifecycle", () => {
  it("queues an approved session at its end boundary", () => {
    const endedAt = new Date("2026-08-05T22:00:00.000Z").getTime();
    expect(pendingSessionReviews([session()], endedAt)).toHaveLength(1);
  });

  it("does not queue proposed, future, or already reviewed sessions", () => {
    const now = new Date("2026-08-05T22:00:00.000Z").getTime();
    expect(
      pendingSessionReviews(
        [
          session({ id: "proposed", status: "proposed" }),
          session({ id: "future", end: "2026-08-05T23:00:00.000Z" }),
          session({ id: "complete", status: "completed" }),
        ],
        now,
      ),
    ).toHaveLength(0);
  });

  it("honors the still-working check-in delay", () => {
    const delayed = session({
      status: "in_progress",
      reviewAfter: "2026-08-05T22:15:00.000Z",
    });
    expect(
      pendingSessionReviews(
        [delayed],
        new Date("2026-08-05T22:14:59.000Z").getTime(),
      ),
    ).toHaveLength(0);
    expect(
      pendingSessionReviews(
        [delayed],
        new Date("2026-08-05T22:15:00.000Z").getTime(),
      ),
    ).toHaveLength(1);
  });

  it("calculates remaining effort for a partial outcome", () => {
    const review = createSessionReview(
      session(),
      "partial",
      "2026-08-05T22:01:00.000Z",
      25,
    );
    expect(review.completedMinutes).toBe(25);
    expect(review.remainingMinutes).toBe(35);
  });

  it("rejects an impossible partial outcome", () => {
    expect(() =>
      createSessionReview(
        session(),
        "partial",
        "2026-08-05T22:01:00.000Z",
        60,
      ),
    ).toThrow("between 1 and 59");
  });
});
