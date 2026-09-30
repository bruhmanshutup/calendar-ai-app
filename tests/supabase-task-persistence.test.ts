import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ExtractedTask } from "../lib/domain/types";
import { toSupabaseTaskRow } from "../lib/repositories/supabase-task-row";

const afternoon = {
  start: "2026-09-03T12:00:00-07:00",
  end: "2026-09-03T17:00:00-07:00",
  label: "Thursday afternoon",
  precision: "named_period" as const,
};

const semanticTask: ExtractedTask = {
  id: "review-feedback",
  title: "Review feedback",
  taskType: "flexible",
  responsibilityKind: "task",
  deadlineStrength: "soft",
  dueDate: "2026-09-03",
  occurrenceWindow: afternoon,
  estimatedMinutes: 60,
  durationRange: {
    minimumMinutes: 45,
    preferredMinutes: 60,
    maximumMinutes: 90,
  },
  priority: "medium",
  category: "school",
  energyDemand: "medium",
  splittable: false,
  schedulingConstraints: {
    allowedDateWindows: [afternoon],
  },
  confidence: 0.91,
  fieldConfidence: { title: 1, taskType: 0.95 },
  missingInformation: [],
  sourceText: "Review feedback Thursday afternoon if it arrives.",
  dependencies: [
    {
      taskId: "send-draft",
      targetTitle: "Send draft",
      relation: "after",
      strength: "hard",
      minimumGapMinutes: 30,
      maximumLagMinutes: 24 * 60,
    },
  ],
  conditionalRules: [
    {
      condition: "Feedback arrives",
      effect: "Review it Thursday afternoon",
      requiresReview: true,
    },
  ],
};

describe("Supabase semantic task persistence", () => {
  it("maps top-level and nested semantic metadata without narrowing JSON", () => {
    const row = toSupabaseTaskRow(
      "user-1",
      "source-1",
      semanticTask,
      "2026-09-02T18:00:00Z",
    );

    expect(row).toMatchObject({
      responsibility_kind: "task",
      deadline_strength: "soft",
      occurrence_window: afternoon,
      duration_range: semanticTask.durationRange,
      scheduling_constraints: semanticTask.schedulingConstraints,
      dependencies: semanticTask.dependencies,
      conditional_rules: semanticTask.conditionalRules,
    });
  });

  it("adds database columns and enum guards for the semantic metadata", async () => {
    const sql = await readFile(
      new URL(
        "../supabase/migrations/202609020001_semantic_task_metadata.sql",
        import.meta.url,
      ),
      "utf8",
    );

    for (const column of [
      "responsibility_kind",
      "deadline_strength",
      "occurrence_window",
      "duration_range",
      "conditional_rules",
    ]) {
      expect(sql).toContain(`add column if not exists ${column}`);
    }
    expect(sql).toContain("tasks_responsibility_kind_check");
    expect(sql).toContain("tasks_deadline_strength_check");
  });
});
