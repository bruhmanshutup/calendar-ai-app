import { describe, expect, it } from "vitest";
import { migrateWorkspaceTimeZone, type PersistedWorkspace } from "../lib/domain/workspace-state";

function legacyWorkspace(): PersistedWorkspace {
  return {
    version: 1,
    tasks: [],
    proposal: {
      id: "p",
      sessions: [
        {
          id: "s1",
          taskId: "t1",
          title: "CHEM 151-0 Lecture",
          start: "2026-09-30T17:00:00.000Z", // 10:00 AM Pacific
          end: "2026-09-30T17:50:00.000Z",
          minutes: 50,
          status: "approved",
          locked: true,
          reviewedAt: "2026-09-30T18:05:00.000Z",
          reasonCodes: [],
          explanation: "",
        },
      ],
      breaks: [],
      unschedulable: [],
      planHealth: {
        scheduledPercent: 100,
        deadlinesAtRisk: 0,
        unscheduledMinutes: 0,
        bufferMinutesRetained: 0,
        demandingFocusBlocks: 0,
        fragmentedTaskIds: [],
        recurringGoalsOnTrack: 0,
        recurringGoalsBehind: 0,
        summary: "",
      },
      availableMinutes: 0,
      plannedMinutes: 50,
      bufferMinutes: 0,
    },
    importText: "",
    history: [{ id: "h", at: "2026-09-29T23:00:00.000Z", icon: "edit", title: "x", detail: "" }],
    sessionReviews: [],
    planningMode: "balanced",
    planningRules: { blockedTimes: [{ start: "2026-11-01T15:00:00.000Z", end: "2026-11-01T16:00:00.000Z", label: "Busy" }] } as PersistedWorkspace["planningRules"],
  };
}

describe("workspace time zone migration", () => {
  it("keeps planned clock times when moving an old Pacific workspace to Central", () => {
    const migrated = migrateWorkspaceTimeZone(legacyWorkspace(), "America/Chicago");
    expect(migrated.timeZone).toBe("America/Chicago");
    expect(migrated.proposal.sessions[0].start).toBe("2026-09-30T15:00:00.000Z"); // 10:00 AM Central
    expect(migrated.proposal.sessions[0].end).toBe("2026-09-30T15:50:00.000Z");
    // After daylight saving ends: 7:00 AM Pacific becomes 7:00 AM Central.
    expect(migrated.planningRules?.blockedTimes?.[0].start).toBe("2026-11-01T13:00:00.000Z");
  });

  it("leaves real moments that already happened untouched", () => {
    const migrated = migrateWorkspaceTimeZone(legacyWorkspace(), "America/Chicago");
    expect(migrated.proposal.sessions[0].reviewedAt).toBe("2026-09-30T18:05:00.000Z");
    expect(migrated.history[0].at).toBe("2026-09-29T23:00:00.000Z");
  });

  it("does nothing the second time", () => {
    const once = migrateWorkspaceTimeZone(legacyWorkspace(), "America/Chicago");
    const twice = migrateWorkspaceTimeZone(once, "America/Chicago");
    expect(twice.proposal.sessions[0].start).toBe(once.proposal.sessions[0].start);
  });
});
