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
  });

  it("does not add the same interpreted responsibility twice", () => {
    const existing = task({ id: "existing", title: "Submit report" });
    const duplicate = task({ id: "another-id", title: "Submit report" });

    const result = mergeImportedTasks([existing], [duplicate]);

    expect(result.tasks).toEqual([existing]);
    expect(result.addedTasks).toEqual([]);
    expect(result.duplicateCount).toBe(1);
  });
});
