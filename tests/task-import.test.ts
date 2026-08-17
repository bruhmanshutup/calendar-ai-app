import { describe, expect, it } from "vitest";
import { mergeImportedTasks } from "../lib/domain/task-import";
import { task } from "./fixtures";

describe("responsibility imports", () => {
  it("adds new responsibilities without replacing existing ones", () => {
    const existing = task({ id: "imported-1", title: "Existing task" });
    const incoming = task({ id: "imported-1", title: "New task" });

    const result = mergeImportedTasks(
      [existing],
      [incoming],
      () => "generated-2",
    );

    expect(result.tasks.map((item) => item.title)).toEqual([
      "Existing task",
      "New task",
    ]);
    expect(result.tasks.map((item) => item.id)).toEqual([
      "imported-1",
      "generated-2",
    ]);
    expect(result.addedTasks).toHaveLength(1);
    expect(result.importedTaskIds).toEqual(["generated-2"]);
  });

  it("does not add the same interpreted responsibility twice", () => {
    const existing = task({ id: "existing", title: "Submit report" });
    const duplicate = task({ id: "another-id", title: "Submit report" });

    const result = mergeImportedTasks([existing], [duplicate]);

    expect(result.tasks).toEqual([existing]);
    expect(result.addedTasks).toEqual([]);
    expect(result.importedTaskIds).toEqual(["existing"]);
    expect(result.duplicateCount).toBe(1);
  });

  it("cleans previously misclassified portal navigation without deleting real tasks", () => {
    const navigation = task({
      id: "navigation",
      title: "Purple Prep Checklist",
      sourceText:
        "[Purple Prep Checklist](https://go.sa.northwestern.edu/newstudent/)",
    });
    const monthHeading = task({
      id: "month-heading",
      title: "Due in August",
      sourceText: "Due in August",
    });
    const real = task({ id: "exercise", title: "Exercise" });

    const result = mergeImportedTasks([navigation, monthHeading, real], []);

    expect(result.tasks).toEqual([real]);
    expect(result.removedMetadataCount).toBe(2);
  });

  it("refreshes Markdown-polluted task fields without changing the task identity", () => {
    const sourceText = "**Select a move-in appointment** 8/21/26";
    const existing = task({
      id: "existing-appointment",
      title: "**Select a move-in appointment**",
      sourceText,
      taskType: "fixed_time",
    });
    const corrected = task({
      id: "incoming",
      title: "Select a move-in appointment",
      sourceText,
      taskType: "flexible",
      dueDate: "2026-08-21",
    });

    const result = mergeImportedTasks([existing], [corrected]);

    expect(result.tasks).toEqual([
      expect.objectContaining({
        id: "existing-appointment",
        title: "Select a move-in appointment",
        taskType: "flexible",
        dueDate: "2026-08-21",
      }),
    ]);
    expect(result.importedTaskIds).toEqual(["existing-appointment"]);
    expect(result.refreshedTaskCount).toBe(1);
  });

  it("repairs a legacy agenda row without duplicating the responsibility", () => {
    const sourceText = "6:30 PM — Group project meeting";
    const existing = task({
      id: "legacy-meeting",
      title: sourceText,
      sourceText,
      taskType: "fixed_time",
      fixedStartAt: "2026-08-21T01:30:00.000Z",
      fixedEndAt: "2026-08-21T02:30:00.000Z",
    });
    const corrected = task({
      id: "incoming",
      title: "Group project meeting",
      sourceText,
      taskType: "fixed_time",
      fixedStartAt: "2026-08-19T01:30:00.000Z",
      fixedEndAt: "2026-08-19T02:15:00.000Z",
    });

    const result = mergeImportedTasks([existing], [corrected]);

    expect(result.tasks).toEqual([
      expect.objectContaining({
        id: "legacy-meeting",
        title: "Group project meeting",
        fixedStartAt: "2026-08-19T01:30:00.000Z",
        fixedEndAt: "2026-08-19T02:15:00.000Z",
      }),
    ]);
    expect(result.addedTasks).toEqual([]);
    expect(result.refreshedTaskCount).toBe(1);
  });

  it("refreshes corrected timing for an otherwise clean agenda row", () => {
    const sourceText = "6:00 PM — Email Professor Anderson";
    const existing = task({
      id: "existing-email",
      title: "Email Professor Anderson",
      sourceText,
      taskType: "fixed_time",
      fixedStartAt: "2026-08-18T01:00:00.000Z",
      fixedEndAt: "2026-08-18T01:45:00.000Z",
      estimatedMinutes: 45,
    });
    const corrected = task({
      id: "incoming-email",
      title: "Email Professor Anderson",
      sourceText,
      taskType: "fixed_time",
      fixedStartAt: "2026-08-18T01:00:00.000Z",
      fixedEndAt: "2026-08-18T01:30:00.000Z",
      estimatedMinutes: 30,
    });

    const result = mergeImportedTasks([existing], [corrected]);

    expect(result.tasks).toEqual([
      expect.objectContaining({
        id: "existing-email",
        fixedEndAt: "2026-08-18T01:30:00.000Z",
        estimatedMinutes: 30,
      }),
    ]);
    expect(result.refreshedTaskCount).toBe(1);
  });

  it("preserves approval when an agenda row is re-imported unchanged", () => {
    const sourceText = "7:30 PM — Gym";
    const existing = task({
      id: "approved-gym",
      title: "Gym",
      sourceText,
      taskType: "fixed_time",
      fixedStartAt: "2026-08-18T02:30:00.000Z",
      fixedEndAt: "2026-08-18T03:30:00.000Z",
      estimatedMinutes: 60,
      approved: true,
      reviewRequired: false,
    });
    const duplicate = task({
      id: "incoming-gym",
      title: "Gym",
      sourceText,
      taskType: "fixed_time",
      fixedStartAt: existing.fixedStartAt,
      fixedEndAt: existing.fixedEndAt,
      estimatedMinutes: 60,
      approved: false,
      reviewRequired: true,
    });

    const result = mergeImportedTasks([existing], [duplicate]);

    expect(result.tasks).toEqual([existing]);
    expect(result.refreshedTaskCount).toBe(0);
  });

  it("replaces prior collapsed learning-plan summaries when checklist items are recovered", () => {
    const collapsedPlan = task({
      id: "collapsed-plan",
      title: "Complete 12-Week Electronics Cooling Learning Plan",
      sourceText: "12-Week Electronics Cooling Learning Plan",
      taskType: "recurring_goal",
    });
    const collapsedChecklist = task({
      id: "collapsed-checklist",
      title: "Daily checklist",
      sourceText: "Daily checklist:",
      taskType: "recurring_goal",
    });
    const unrelated = task({ id: "exercise", title: "Exercise" });
    const recovered = task({
      id: "structured-plan-w001-d001",
      title: "Week 1, Day 1: Read the course overview",
      sourceText:
        "Week 1 — Heat Transfer Fundamentals\n☐ Day 1: Read the course overview.",
    });

    const result = mergeImportedTasks(
      [collapsedPlan, collapsedChecklist, unrelated],
      [recovered],
    );

    expect(result.tasks.map((item) => item.title)).toEqual([
      "Exercise",
      "Week 1, Day 1: Read the course overview",
    ]);
    expect(result.removedMetadataCount).toBe(2);
  });
});
