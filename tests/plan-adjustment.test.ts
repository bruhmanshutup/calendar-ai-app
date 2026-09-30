import { describe, expect, it } from "vitest";
import { previewPlanAdjustment } from "../lib/domain/plan-adjustment";
import type { ExtractedTask } from "../lib/domain/types";
import { task } from "./fixtures";

function planTask(
  id: string,
  groupId: string,
  order: number,
  anchorDate?: string,
): ExtractedTask {
  return task({
    id,
    title: `Plan task ${order}`,
    sequence: {
      groupId,
      order,
      anchorDate,
      minimumGapDays: 1,
    },
  });
}

describe("plan adjustment previews", () => {
  it("sets a selected plan's start to the next Monday without mutating input", () => {
    const tasks = [
      planTask("alpha-1", "alpha", 1, "2026-08-29"),
      task({ id: "unrelated", title: "Unrelated task" }),
      planTask("alpha-2", "alpha", 2, "2026-08-29"),
    ];
    const before = structuredClone(tasks);

    const preview = previewPlanAdjustment({
      command: "start this plan Monday",
      tasks,
      currentLocalDate: "2026-08-29",
      timeZone: "America/Los_Angeles",
    });

    expect(preview).toMatchObject({
      ok: true,
      operation: "set_start",
      operationLabel: "Set plan start to 2026-08-31",
      groupId: "alpha",
      oldAnchor: "2026-08-29",
      newAnchor: "2026-08-31",
      affectedTaskCount: 2,
      affectedTaskIds: ["alpha-1", "alpha-2"],
      errors: [],
    });
    expect(preview.adjustedTasks[0].sequence?.anchorDate).toBe("2026-08-31");
    expect(preview.adjustedTasks[2].sequence?.anchorDate).toBe("2026-08-31");
    expect(preview.adjustedTasks[1]).toBe(tasks[1]);
    expect(tasks).toEqual(before);
  });

  it("can establish an explicit ISO start when the plan has no current anchor", () => {
    const tasks = [planTask("alpha-1", "alpha", 1)];
    const preview = previewPlanAdjustment({
      command: "set plan start to 2026-09-07",
      tasks,
      currentLocalDate: "2026-08-29",
      timeZone: "UTC",
    });

    expect(preview.ok).toBe(true);
    expect(preview.oldAnchor).toBeNull();
    expect(preview.newAnchor).toBe("2026-09-07");
    expect(preview.adjustedTasks[0].sequence?.anchorDate).toBe("2026-09-07");
  });

  it("shifts later by calendar days across a daylight-saving boundary", () => {
    const tasks = [planTask("alpha-1", "alpha", 1, "2026-03-07")];
    const preview = previewPlanAdjustment({
      command: "shift this plan forward two days",
      tasks,
      currentLocalDate: "2026-03-01",
      timeZone: "America/Los_Angeles",
    });

    expect(preview).toMatchObject({
      ok: true,
      operation: "shift_later",
      operationLabel: "Shift plan later by 2 days",
      oldAnchor: "2026-03-07",
      newAnchor: "2026-03-09",
    });
  });

  it("shifts earlier with a numeric day count", () => {
    const tasks = [planTask("alpha-1", "alpha", 1, "2026-01-01")];
    const preview = previewPlanAdjustment({
      command: "move the plan back 1 day",
      tasks,
      currentLocalDate: "2026-01-01",
      timeZone: "UTC",
    });

    expect(preview).toMatchObject({
      ok: true,
      operation: "shift_earlier",
      oldAnchor: "2026-01-01",
      newAnchor: "2025-12-31",
    });
  });

  it("uses recent task IDs to choose one group and otherwise reports ambiguity", () => {
    const tasks = [
      planTask("alpha-1", "alpha", 1, "2026-08-29"),
      planTask("beta-1", "beta", 1, "2026-09-01"),
    ];
    const input = {
      command: "shift this plan down one day",
      tasks,
      currentLocalDate: "2026-08-29",
      timeZone: "UTC",
    };

    const ambiguous = previewPlanAdjustment(input);
    expect(ambiguous).toMatchObject({
      ok: false,
      affectedTaskCount: 0,
      errors: [{ code: "ambiguous_plan" }],
    });

    const selected = previewPlanAdjustment({ ...input, recentTaskIds: ["beta-1"] });
    expect(selected).toMatchObject({
      ok: true,
      groupId: "beta",
      oldAnchor: "2026-09-01",
      newAnchor: "2026-09-02",
      affectedTaskIds: ["beta-1"],
    });
    expect(selected.adjustedTasks[0]).toBe(tasks[0]);
  });

  it("requires an existing anchor for shifts and rejects ambiguous dates", () => {
    const tasks = [planTask("alpha-1", "alpha", 1)];

    const missingAnchor = previewPlanAdjustment({
      command: "shift this plan earlier one day",
      tasks,
      currentLocalDate: "2026-08-29",
      timeZone: "UTC",
    });
    expect(missingAnchor.errors).toEqual([
      expect.objectContaining({ code: "missing_current_anchor" }),
    ]);
    expect(missingAnchor.adjustedTasks).toEqual(tasks);

    const ambiguousDate = previewPlanAdjustment({
      command: "start this plan 8/9",
      tasks,
      currentLocalDate: "2026-08-29",
      timeZone: "UTC",
    });
    expect(ambiguousDate.errors).toEqual([
      expect.objectContaining({ code: "invalid_date" }),
    ]);
  });
});
