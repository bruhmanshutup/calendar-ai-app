import { describe, expect, it } from "vitest";
import {
  taskFieldOrigin,
  withUserFieldProvenance,
} from "../lib/domain/task-provenance";
import { task } from "./fixtures";

describe("task field provenance", () => {
  it("lets a user edit outrank an inferred value without losing other evidence", () => {
    const source = task({
      id: "email",
      title: "Email the adviser",
      fieldProvenance: [
        { path: "title", origin: "explicit" },
        { path: "estimatedMinutes", origin: "inferred" },
      ],
    });
    const fieldProvenance = withUserFieldProvenance(source, [
      "estimatedMinutes",
    ]);
    const updated = { ...source, fieldProvenance };

    expect(taskFieldOrigin(updated, "title")).toBe("explicit");
    expect(taskFieldOrigin(updated, "estimatedMinutes")).toBe("user");
  });
});
