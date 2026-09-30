import { formatInTimeZone } from "date-fns-tz";
import type { ExtractedTask, ExtractionInput } from "@/lib/domain/types";
import type { SemanticDraft } from "./semantic-draft";
import { materializeCalculatedTimeBlock } from "@/lib/domain/calculated-time-block";

type Relation = SemanticDraft["relations"][number];
type Responsibility = SemanticDraft["responsibilities"][number];
type Boundary = "start" | "end";
type Rule = { id: string; target: string; boundary: Boundary; targetBoundary: Boundary; offset: number; maximumOffset?: number; mode: "exact" | "latest" | "earliest"; approximate: boolean; arrival: boolean; reason?: string };

export const CALCULATED_TIMING_REVIEW = "AI-interpreted relationship; times calculated without relationship validation. Shown on the schedule as a fixed proposal; check its timing. These times are independent and do not update with other tasks.";

export function isSpecialTiming(relation: Relation): boolean {
  return Boolean((relation.timing && relation.timing !== "ordering") || relation.minimumGapMinutes || relation.maximumLagMinutes);
}

// Transient references are used only to do the arithmetic in this response.
// They are never persisted as links, groups, or scheduler dependencies.
function rulesFor(draft: SemanticDraft): Rule[] {
  const items = new Map(draft.responsibilities.map((item) => [item.id, item]));
  const selected = new Set(draft.relations.filter(isSpecialTiming));
  for (let pass = 0; pass < draft.responsibilities.length; pass++) {
    const targets = new Set([...selected].map((relation) => relation.fromId));
    const before = selected.size;
    draft.relations.forEach((relation) => { if (targets.has(relation.toId)) selected.add(relation); });
    if (selected.size === before) break;
  }
  return [...selected].map((relation) => {
    const arrival = relation.timing === "arrival_buffer";
    const boundary = relation.fromBoundary ?? (arrival || relation.timing === "offset" ? "start" : relation.relation === "before" ? "end" : "start");
    const targetBoundary = relation.toBoundary ?? (relation.relation === "before" ? "start" : "end");
    const from = items.get(relation.fromId);
    const to = items.get(relation.toId);
    const reverse = from?.kind === "event" && from.occurrence?.startTime && !to?.occurrence?.startTime;
    const offset = (relation.relation === "before" ? -1 : 1) * (relation.minimumGapMinutes ?? 0);
    return {
      id: reverse ? relation.toId : relation.fromId,
      target: reverse ? relation.fromId : relation.toId,
      boundary: reverse ? targetBoundary : boundary,
      targetBoundary: reverse ? boundary : targetBoundary,
      offset: reverse ? -offset : offset,
      maximumOffset: relation.maximumLagMinutes === undefined ? undefined : (reverse ? -1 : 1) * (relation.relation === "before" ? -1 : 1) * relation.maximumLagMinutes,
      mode: relation.mode ?? (relation.timing && relation.timing !== "ordering" ? "exact" : relation.relation === "before" ? "latest" : "earliest"),
      approximate: Boolean(relation.approximate || relation.strength === "soft"),
      arrival: !reverse && arrival,
      reason: relation.reason,
    };
  });
}

export function specialTimingTaskIds(draft: SemanticDraft): Set<string> {
  return new Set(rulesFor(draft).map((rule) => rule.id));
}

const minutesFor = (item: Responsibility, task: ExtractedTask) =>
  item.kind === "milestone" ? 0 : item.duration?.preferredMinutes ?? item.duration?.maximumMinutes ?? item.duration?.minimumMinutes ?? item.planning?.estimatedMinutes ?? task.estimatedMinutes;

/**
 * AI owns interpretation. This branch only evaluates endpoint + offset and
 * endpoint +/- duration. No quote, keyword, gap-role, recurrence, feasibility,
 * or competing-boundary checks. A bounded evaluation avoids infinite loops;
 * absent operands cannot produce a timestamp. Neither is a semantic verdict.
 */
export function calculateAiTiming(input: ExtractionInput, tasks: ExtractedTask[], draft: SemanticDraft): void {
  const rules = rulesFor(draft);
  const byId = new Map(tasks.map((task) => [task.id!, task]));
  const sourceById = new Map(draft.responsibilities.map((item) => [item.id, item]));
  const calculatedIds = new Set(rules.map((rule) => rule.id));
  const values = new Map<string, { start?: number; end?: number; approximate: boolean }>();
  for (const task of tasks) {
    if (calculatedIds.has(task.id!)) {
      task.dependencies = undefined;
      task.sequence = undefined;
      const item = sourceById.get(task.id!)!;
      task.schedulingConstraints = {
        ...task.schedulingConstraints,
        linkedTiming: undefined,
        calculatedTiming: { approximate: Boolean(item.duration?.approximate), durationEstimated: item.duration?.explicit !== true },
      };
      // These are calculator outputs, not literal clocks to ground in text.
      task.fixedStartAt = undefined;
      task.fixedEndAt = undefined;
      if (item.kind === "milestone") {
        task.dueAt = undefined;
        task.dueTime = undefined;
      }
      task.reviewRequired = true;
      task.approved = false;
      task.missingInformation = [...item.missingInformation, CALCULATED_TIMING_REVIEW];
      continue;
    }
    const point = task.responsibilityKind === "milestone" ? task.dueAt : undefined;
    values.set(task.id!, {
      start: task.fixedStartAt || point ? Date.parse((task.fixedStartAt ?? point)!) : undefined,
      end: task.fixedEndAt || point || task.dueAt ? Date.parse((task.fixedEndAt ?? point ?? task.dueAt)!) : undefined,
      approximate: Boolean(task.reviewRequired),
    });
  }
  const pending = new Set(calculatedIds);
  for (let pass = 0; pass < tasks.length && pending.size; pass++) {
    for (const rule of rules) {
      if (!pending.has(rule.id)) continue;
      const target = values.get(rule.target);
      const anchor = target?.[rule.targetBoundary];
      const task = byId.get(rule.id);
      const item = sourceById.get(rule.id);
      if (anchor === undefined || !Number.isFinite(anchor) || !task || !item) continue;
      const point = rule.arrival || item.kind === "milestone";
      const duration = point ? 0 : minutesFor(item, task);
      if (duration === undefined) continue;
      const endpoint = anchor + rule.offset * 60_000;
      const start = rule.boundary === "start" ? endpoint : endpoint - duration * 60_000;
      const end = point ? start : start + duration * 60_000;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const approximate = Boolean(target?.approximate || rule.approximate || item.duration?.approximate || (!point && item.duration?.explicit !== true));
      values.set(rule.id, { start, end, approximate });
      pending.delete(rule.id);
      const startAt = new Date(start).toISOString();
      const endAt = new Date(end).toISOString();
      const metadata = task.schedulingConstraints!.calculatedTiming!;
      metadata.approximate = approximate;
      metadata.durationEstimated = !point && (item.duration?.explicit !== true || item.duration?.approximate === true);
      let paths: string[];
      if (point) {
        task.responsibilityKind = "milestone";
        task.taskType = "flexible";
        task.estimatedMinutes = undefined;
        task.minimumSessionMinutes = undefined;
        task.durationRange = undefined;
        task.dueAt = startAt;
        task.dueDate = formatInTimeZone(startAt, input.timeZone, "yyyy-MM-dd");
        task.dueTime = formatInTimeZone(startAt, input.timeZone, "HH:mm");
        task.deadlineStrength = approximate ? "soft" : "hard";
        if (rule.arrival && anchor > start) metadata.buffer = { start: startAt, end: new Date(anchor).toISOString() };
        paths = ["dueAt", "dueDate", "dueTime"];
      } else {
        task.fixedStartAt = startAt;
        task.fixedEndAt = endAt;
        task.taskType = "fixed_time";
        task.estimatedMinutes = duration;
        task.splittable = false;
        task.occurrenceWindow = undefined;
        paths = ["fixedStartAt", "fixedEndAt"];
        if (!item.deadline && rule.mode === "latest" && sourceById.get(rule.target)?.kind === "milestone") {
          task.dueAt = endAt;
          task.dueDate = formatInTimeZone(endAt, input.timeZone, "yyyy-MM-dd");
          task.dueTime = formatInTimeZone(endAt, input.timeZone, "HH:mm");
          task.deadlineStrength = rule.approximate ? "soft" : "hard";
          paths.push("dueAt", "dueDate", "dueTime");
        }
        if (rule.maximumOffset !== undefined) {
          const otherEndpoint = anchor + rule.maximumOffset * 60_000;
          const otherStart = rule.boundary === "start" ? otherEndpoint : otherEndpoint - duration * 60_000;
          task.schedulingConstraints!.allowedDateWindows = [{ start: new Date(Math.min(start, otherStart)).toISOString(), end: new Date(Math.max(end, otherStart + duration * 60_000)).toISOString(), label: "AI-interpreted timing range", precision: approximate ? "approximate" : "exact" }];
        }
      }
      task.fieldProvenance = [
        ...(task.fieldProvenance ?? []).filter((field) => !paths.includes(field.path) && !field.path.startsWith("relationships.")),
        ...paths.map((path) => ({ path, origin: "derived" as const, rationale: `${rule.reason ?? "AI-interpreted timing"} Calculated from a ${rule.offset}-minute endpoint offset${point ? "" : ` and ${duration}-minute duration`}${approximate ? "; approximate timing" : ""}. Relationship not validated; independent snapshot.` })),
      ];
      task.missingInformation = task.missingInformation.filter((message) => message !== "Exact event start and end time are not specified.");
    }
  }
  for (const id of pending) {
    const task = byId.get(id);
    if (task) task.missingInformation.push("Calculator needs an anchor date/time and duration to produce a time. No relationship validation was performed.");
  }
  // Keep checkpoints as arithmetic operands until every chain is calculated,
  // then materialize nonzero buffer intervals as normal fixed calendar blocks.
  tasks.forEach((task, index) => { tasks[index] = materializeCalculatedTimeBlock(task); });
}
