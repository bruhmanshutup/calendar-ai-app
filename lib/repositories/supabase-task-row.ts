import type { ExtractedTask } from "@/lib/domain/types";

/**
 * Keep the task-to-database mapping independently testable. Nested semantic
 * metadata remains JSON so newly added members are not discarded by a mapper.
 */
export function toSupabaseTaskRow(
  userId: string,
  sourceId: string,
  task: ExtractedTask,
  approvedAt: string | null,
) {
  return {
    user_id: userId,
    source_id: sourceId,
    title: task.title,
    description: task.description,
    task_type: task.taskType,
    responsibility_kind: task.responsibilityKind,
    deadline_strength: task.deadlineStrength,
    due_date: task.dueDate,
    due_time: task.dueTime,
    due_at: task.dueAt,
    due_window: task.dueWindow,
    occurrence_window: task.occurrenceWindow,
    fixed_start_at: task.fixedStartAt,
    fixed_end_at: task.fixedEndAt,
    estimated_minutes: task.estimatedMinutes,
    duration_range: task.durationRange,
    effort_estimate_source: task.effortEstimateSource,
    effort_estimate_rationale: task.effortEstimateRationale,
    priority: task.priority,
    category: task.category,
    energy_demand: task.energyDemand,
    splittable: task.splittable,
    minimum_session_minutes: task.minimumSessionMinutes,
    scheduling_constraints: task.schedulingConstraints,
    recurrence: task.recurrence,
    confidence: task.confidence,
    field_confidence: task.fieldConfidence,
    missing_information: task.missingInformation,
    source_excerpt: task.sourceText,
    source_span: task.sourceSpan,
    field_provenance: task.fieldProvenance,
    dependencies: task.dependencies,
    conditional_rules: task.conditionalRules,
    review_required: task.reviewRequired ?? false,
    approved_at: approvedAt,
  };
}
