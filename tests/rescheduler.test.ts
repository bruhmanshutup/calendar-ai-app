import { describe, expect, it } from "vitest";
import { proposeMinimalReplan } from "../lib/domain/rescheduler";
import type { ExistingSession } from "../lib/domain/types";
import { scheduling, task, TEST_PREFERENCES } from "./fixtures";

const missed: ExistingSession = {
  id: "missed",
  taskId: "work",
  title: "Work",
  start: "2026-07-27T08:00:00.000Z",
  end: "2026-07-27T08:45:00.000Z",
  locked: false,
  status: "missed",
};

const future: ExistingSession = {
  id: "future",
  taskId: "other",
  title: "Future",
  start: "2026-07-27T10:00:00.000Z",
  end: "2026-07-27T10:45:00.000Z",
  locked: false,
  status: "proposed",
};

const locked: ExistingSession = {
  id: "locked",
  taskId: "locked-task",
  title: "Locked",
  start: "2026-07-27T11:00:00.000Z",
  end: "2026-07-27T11:45:00.000Z",
  locked: true,
  status: "approved",
};

function replan(outcome: "missed" | "partial", minutesCompleted?: number) {
  const base = scheduling([]);
  return proposeMinimalReplan({
    session: missed,
    outcome,
    minutesCompleted,
    sessions: [missed, future, locked],
    task: task({ id: "work", title: "Work" }),
    scheduling: {
      windowStart: base.windowStart,
      windowEnd: base.windowEnd,
      preferences: TEST_PREFERENCES,
      availability: base.availability,
      unavailableEvents: [],
      blockedTimes: [],
    },
  });
}

describe("minimal-disruption replanning", () => {
  it("moves missed work into a free slot", () => {
    const proposal = replan("missed");
    expect(proposal.changes).toHaveLength(1);
    expect(proposal.changes[0].type).toBe("move");
    expect("after" in proposal.changes[0] && proposal.changes[0].after.start)
      .not.toBe(missed.start);
    expect("after" in proposal.changes[0] && proposal.changes[0].after.taskId)
      .toBe(missed.taskId);
  });

  it("calculates explicit remaining time for partial work", () => {
    const proposal = replan("partial", 20);
    expect(proposal.remainingMinutes).toBe(25);
    expect(proposal.explanation).toContain("20 of 45 minutes");
  });

  it("never moves locked sessions", () => {
    const proposal = replan("missed");
    expect(proposal.preservedSessionIds).toContain(locked.id);
    expect(
      proposal.changes.some(
        (change) =>
          change.type === "move" && change.sessionId === locked.id,
      ),
    ).toBe(false);
  });

  it("keeps existing valid future sessions unchanged", () => {
    const proposal = replan("missed");
    expect(proposal.preservedSessionIds).toContain(future.id);
    expect(
      proposal.changes.some(
        (change) =>
          change.type === "move" && change.sessionId === future.id,
      ),
    ).toBe(false);
  });

  it("moves the minimal number of sessions", () => {
    expect(replan("missed").changes).toHaveLength(1);
  });

  it("returns a diff proposal without mutating the source sessions", () => {
    const original = [missed, future, locked];
    const snapshot = structuredClone(original);
    const proposal = replan("missed");
    expect(proposal.changes[0]).toHaveProperty("before");
    expect(original).toEqual(snapshot);
  });
});
