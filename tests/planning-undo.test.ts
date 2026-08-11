import { describe, expect, it } from "vitest";
import {
  popPlanningUndo,
  pushPlanningUndo,
  type PlanningUndoSnapshot,
} from "../lib/domain/planning-undo";
import { generateSchedule } from "../lib/domain/scheduler";
import { scheduling, task } from "./fixtures";

function snapshot(label: string): PlanningUndoSnapshot {
  const tasks = [task({ id: label, title: label })];
  return {
    label,
    tasks,
    proposal: generateSchedule(scheduling(tasks)),
    planningMode: "balanced",
    selectedSessionIds: [],
    sessionReviews: [],
    lastImportedTaskIds: [],
  };
}

describe("schedule undo history", () => {
  it("restores changes in last-in, first-out order", () => {
    const first = snapshot("first change");
    const second = snapshot("second change");
    const stack = pushPlanningUndo(pushPlanningUndo([], first), second);

    const result = popPlanningUndo(stack);

    expect(result.snapshot).toBe(second);
    expect(result.remaining).toEqual([first]);
  });

  it("coalesces repeated snapshots from one batched action", () => {
    const first = snapshot("session approval");
    const once = pushPlanningUndo([], first);
    const twice = pushPlanningUndo(once, { ...first, label: "another approval" });

    expect(twice).toBe(once);
  });

  it("keeps the most recent twenty changes", () => {
    const stack = Array.from({ length: 24 }, (_, index) =>
      snapshot(`change ${index + 1}`),
    ).reduce(pushPlanningUndo, [] as PlanningUndoSnapshot[]);

    expect(stack).toHaveLength(20);
    expect(stack[0]?.label).toBe("change 5");
    expect(stack.at(-1)?.label).toBe("change 24");
  });
});
