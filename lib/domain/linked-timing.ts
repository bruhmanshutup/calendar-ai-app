import { formatInTimeZone } from "date-fns-tz";
import type { ExtractedTask, TimeInterval } from "./types";
import { withUserFieldProvenance } from "./task-provenance";

const MINUTE = 60_000;
const UNRESOLVED = "Linked timing could not be recalculated. Confirm the related event, date, duration, or conflicting timing. The displayed proposal may be out of date.";
const UPDATED = "Linked timing changed with the related event or duration. Review the updated date and times.";
const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
type Bounds = { start?: number; end?: number; approximate: boolean };

function review(task: ExtractedTask, message: string) {
  task.reviewRequired = true;
  task.approved = false;
  if (!task.missingInformation.includes(message)) task.missingInformation.push(message);
}

function clearCalculatedWindows(task: ExtractedTask) {
  for (const key of ["allowedDateWindows", "preferredDateWindows"] as const) {
    if (task.fieldProvenance?.some((field) => field.path === `schedulingConstraints.${key}` && field.origin === "derived" && /calculated from the cited relationship/.test(field.rationale ?? ""))) {
      if (task.schedulingConstraints) task.schedulingConstraints[key] = undefined;
    }
  }
}

/** Replays saved arithmetic only; it does not parse wording or call a model. */
export function recalculateLinkedTiming(tasks: ExtractedTask[], timeZone: string): ExtractedTask[] {
  const result = structuredClone(tasks);
  const byId = new Map(result.map((task) => [task.id, task]));
  const resolved = new Map<string, Bounds | undefined>();
  const visiting = new Set<string>();
  const solve = (id: string): Bounds | undefined => {
    if (resolved.has(id)) return resolved.get(id);
    const task = byId.get(id);
    if (!task || task.cancelled) return undefined;
    const linked = task.schedulingConstraints?.linkedTiming;
    if (!linked || task.completed) {
      const point = task.responsibilityKind === "milestone" ? time(task.dueAt) : undefined;
      return {
        start: time(task.fixedStartAt) ?? point,
        end: time(task.fixedEndAt) ?? point,
        approximate: Boolean(task.fieldProvenance?.some((field) => field.path === "fixedStartAt" && field.origin === "inferred")),
      };
    }
    if (visiting.has(id)) return undefined;
    visiting.add(id);
    const fail = () => {
      linked.unresolved = true;
      review(task, UNRESOLVED);
      resolved.set(id, undefined);
      visiting.delete(id);
      return undefined;
    };
    const values = linked.rules.map((rule) => {
      const target = solve(rule.taskId);
      const anchor = target?.[rule.targetBoundary];
      const inferredEnd = rule.targetBoundary === "end" && byId.get(rule.taskId)?.fieldProvenance?.some((field) => field.path === "fixedEndAt" && field.origin === "inferred");
      return anchor === undefined ? undefined : { ...rule, value: anchor + rule.offsetMinutes * MINUTE, uncertain: target!.approximate || rule.approximate || Boolean(inferredEnd) };
    });
    if (values.some((value) => !value)) return fail();
    const rules = values.filter((value) => value !== undefined);
    const milestone = task.responsibilityKind === "milestone";
    const exact = (boundary: "start" | "end") => rules.filter((rule) => rule.mode === "exact" && rule.boundary === boundary).map((rule) => rule.value);
    const starts = exact("start"), ends = exact("end");
    if (new Set(starts).size > 1 || new Set(ends).size > 1) return fail();
    let start: number | undefined = starts[0], end: number | undefined = ends[0];
    if (milestone) {
      start ??= end ?? rules.filter((rule) => rule.mode === "latest").sort((a, b) => a.value - b.value)[0]?.value
        ?? rules.filter((rule) => rule.mode === "earliest").sort((a, b) => b.value - a.value)[0]?.value;
      end = start;
    } else {
      const minutes = task.estimatedMinutes;
      if (!minutes || !Number.isInteger(minutes) || minutes > 1440) return fail();
      if (start === undefined && end !== undefined) start = end - minutes * MINUTE;
      if (end === undefined && start !== undefined) end = start + minutes * MINUTE;
      if (start !== undefined && end !== undefined && end - start !== minutes * MINUTE) return fail();
    }
    if (start === undefined || end === undefined || !Number.isFinite(start) || !Number.isFinite(end)) return fail();
    if (rules.some((rule) => {
      const boundary = rule.boundary === "start" ? start! : end!;
      return rule.mode === "latest" ? boundary > rule.value : rule.mode === "earliest" ? boundary < rule.value : boundary !== rule.value;
    })) return fail();
    if (!milestone && task.deadlineStrength === "hard" && time(task.dueAt) !== undefined && end > time(task.dueAt)!) return fail();
    const nextStart = new Date(start).toISOString(), nextEnd = new Date(end).toISOString();
    const changed = milestone ? time(task.dueAt) !== start : time(task.fixedStartAt) !== start || time(task.fixedEndAt) !== end;
    const wasUnresolved = linked.unresolved;
    linked.unresolved = false;
    linked.approximate = linked.durationEstimated || rules.some((rule) => rule.uncertain);
    task.missingInformation = task.missingInformation.filter((message) => message !== UNRESOLVED);
    if (milestone) {
      task.dueAt = nextStart;
      task.dueDate = formatInTimeZone(nextStart, timeZone, "yyyy-MM-dd");
      task.dueTime = formatInTimeZone(nextStart, timeZone, "HH:mm");
    } else {
      task.taskType = "fixed_time";
      task.fixedStartAt = nextStart;
      task.fixedEndAt = nextEnd;
      task.occurrenceWindow = undefined;
      task.splittable = false;
    }
    if (changed || wasUnresolved) {
      review(task, UPDATED);
      const paths = milestone ? ["dueAt", "dueDate", "dueTime"] : ["fixedStartAt", "fixedEndAt"];
      const spans = task.fieldProvenance?.flatMap((field) => field.path.startsWith("relationships.") ? field.evidence ?? [] : []) ?? [];
      const evidence = [...new Map(spans.map((span) => [`${span.start}:${span.end}`, span])).values()].slice(0, 8);
      task.fieldProvenance = [
        ...(task.fieldProvenance ?? []).filter((field) => !paths.includes(field.path)),
        ...paths.map((path) => ({ path, origin: "derived" as const, evidence, rationale: "Recalculated from the linked activity and saved numeric relationship." })),
      ];
      // Old compiler-calculated planning bounds must move too, not restrict
      // the new fixed interval to the previous appointment date.
      clearCalculatedWindows(task);
    }
    const bounds = { start, end, approximate: linked.approximate };
    resolved.set(id, bounds);
    visiting.delete(id);
    return bounds;
  };
  result.forEach((task) => { if (task.id) solve(task.id); });
  return result;
}

/** A direct clock edit explicitly overrides that card's formula, not its children. */
export function applyLinkedTaskEdit(tasks: ExtractedTask[], id: string, patch: Partial<ExtractedTask>, timeZone: string): ExtractedTask[] {
  const next = tasks.map((task) => {
    if (task.id !== id) return task;
    const updated = { ...task, ...patch };
    const linked = task.schedulingConstraints?.linkedTiming;
    const clockEdited = ["fixedStartAt", "fixedEndAt", "dueAt", "dueDate", "dueTime"].some((path) => Object.hasOwn(patch, path) && patch[path as keyof ExtractedTask] !== task[path as keyof ExtractedTask]);
    if (Object.hasOwn(patch, "fixedStartAt") && !Object.hasOwn(patch, "fixedEndAt")) {
      const duration = task.fixedStartAt && task.fixedEndAt ? Date.parse(task.fixedEndAt) - Date.parse(task.fixedStartAt) : (task.estimatedMinutes ?? 45) * MINUTE;
      updated.fixedEndAt = patch.fixedStartAt ? new Date(Date.parse(patch.fixedStartAt) + duration).toISOString() : undefined;
    }
    const overrideLink = clockEdited || (patch.taskType !== undefined && patch.taskType !== task.taskType);
    if (linked && overrideLink) {
      updated.schedulingConstraints = { ...updated.schedulingConstraints, linkedTiming: undefined };
      clearCalculatedWindows(updated);
      const targets = new Set(linked.rules.map((rule) => rule.taskId));
      updated.dependencies = updated.dependencies?.filter((dependency) => !targets.has(dependency.taskId ?? ""));
      updated.fieldProvenance = updated.fieldProvenance?.filter((field) => !field.path.startsWith("relationships."));
    }
    if (patch.estimatedMinutes !== undefined && !clockEdited) {
      if (linked && !overrideLink) {
        updated.schedulingConstraints = { ...updated.schedulingConstraints, linkedTiming: { ...linked, durationEstimated: false } };
      } else if (updated.fixedStartAt) {
        updated.fixedEndAt = new Date(Date.parse(updated.fixedStartAt) + patch.estimatedMinutes * MINUTE).toISOString();
      }
    } else if (clockEdited && updated.fixedStartAt && updated.fixedEndAt) {
      updated.estimatedMinutes = Math.round((Date.parse(updated.fixedEndAt) - Date.parse(updated.fixedStartAt)) / MINUTE);
    }
    if (!patch.fieldProvenance) {
      const workflow = new Set(["id", "sourceText", "sourceSpan", "approved", "reviewRequired", "missingInformation", "fieldProvenance", "dependencies", "completed", "completedAt", "completedMinutes", "cancelled", "cancelledAt"]);
      updated.fieldProvenance = withUserFieldProvenance(updated, Object.keys(patch).filter((key) => !workflow.has(key)));
    }
    return updated;
  });
  return recalculateLinkedTiming(next, timeZone);
}

/** Arrival is a zero-work checkpoint; the intervening buffer reserves time. */
export function arrivalBufferReservations(tasks: ExtractedTask[], includePending = false): Array<TimeInterval & { taskId: string; label: string }> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.flatMap((task) => {
    const snapshot = task.schedulingConstraints?.calculatedTiming?.buffer;
    if (snapshot) {
      // The ordinary fixed session now reserves this interval itself.
      if (task.taskType === "fixed_time") return [];
      return task.id && !task.completed && !task.cancelled && (includePending || !task.reviewRequired)
        ? [{ ...snapshot, taskId: task.id, label: `Reserved time for ${task.title}` }] : [];
    }
    const linked = task.schedulingConstraints?.linkedTiming;
    if (!task.id || task.completed || task.cancelled || !linked?.arrivalBuffer || linked.unresolved || (!includePending && task.reviewRequired)) return [];
    const rule = linked.rules.find((candidate) => candidate.targetBoundary === "start" && candidate.offsetMinutes < 0);
    const target = rule && byId.get(rule.taskId);
    if (!target || target.cancelled || target.completed || (!includePending && target.reviewRequired)) return [];
    const start = time(task.dueAt), end = time(target.fixedStartAt);
    return start !== undefined && end !== undefined && end > start
      ? [{ taskId: task.id, start: new Date(start).toISOString(), end: new Date(end).toISOString(), label: `Arrival buffer before ${target.title}` }] : [];
  });
}
