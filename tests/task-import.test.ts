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
});
