import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { ExtractedTask, ExtractionInput, SourceEvidenceSpan, TemporalWindow } from "@/lib/domain/types";
import type { SemanticDraft } from "./semantic-draft";
import { interpretedWorkDuration, RELATIONSHIP_REVIEW_MESSAGE, type QuotedTiming } from "./quoted-timing";

export function requireTimingReview(task: ExtractedTask, message: string): void {
  if (!task.missingInformation.includes(message)) task.missingInformation.push(message);
  task.reviewRequired = true;
  task.approved = false;
}

function provenance(task: ExtractedTask, paths: string[], evidence: SourceEvidenceSpan[], rationale: string): void {
  const uniqueEvidence = [...new Map(evidence.map((span) => [`${span.start}:${span.end}`, span])).values()];
  task.fieldProvenance = [
    ...(task.fieldProvenance ?? []).filter((field) => !paths.includes(field.path)),
    ...paths.map((path) => ({ path, origin: "derived" as const, evidence: uniqueEvidence, rationale })),
  ];
}

type Bound = { value: number; approximate: boolean; evidence: SourceEvidenceSpan[] };
type Resolved = { start?: Bound; end?: Bound; latestEnd?: Bound; earliestStart?: Bound };
const instant = (value: string | undefined) => value ? Date.parse(value) : undefined;

/** Calculates from quoted AI interpretations. Arithmetic is checked; meaning needs review. */
export function deriveVerifiedTimes(
  input: ExtractionInput,
  tasks: ExtractedTask[],
  draft: SemanticDraft,
  links: QuotedTiming[],
): void {
  const byId = new Map(tasks.map((task) => [task.id!, task]));
  const sourceById = new Map(draft.responsibilities.map((item) => [item.id, item]));
  const linksById = new Map<string, QuotedTiming[]>();
  // Either endpoint can carry the anchor. “Inspection before cleaning” and
  // “cleaning after inspection” must produce the same calculation.
  const known = new Set(tasks.filter((task) => task.fixedStartAt || (task.responsibilityKind === "milestone" && task.dueAt)).map((task) => task.id!));
  const remaining = new Set(links);
  const oriented: QuotedTiming[] = [];
  for (let pass = 0; pass <= tasks.length && remaining.size; pass++) {
    let progress = false;
    for (const link of remaining) {
      const fromKnown = known.has(link.relation.fromId);
      const toKnown = known.has(link.relation.toId);
      if (!fromKnown && !toKnown) continue;
      const reverse = fromKnown && !toKnown;
      oriented.push(reverse ? {
        ...link,
        fromBoundary: link.toBoundary,
        toBoundary: link.fromBoundary,
        mode: link.mode === "latest" ? "earliest" : link.mode === "earliest" ? "latest" : "exact",
        relation: { ...link.relation, fromId: link.relation.toId, toId: link.relation.fromId, relation: link.relation.relation === "before" ? "after" : "before" },
        arrival: false,
        travel: false,
      } : link);
      known.add(reverse ? link.relation.toId : link.relation.fromId);
      remaining.delete(link);
      progress = true;
    }
    if (!progress) break;
  }
  [...oriented, ...remaining].forEach((link) => linksById.set(link.relation.fromId, [...(linksById.get(link.relation.fromId) ?? []), link]));
  const resolved = new Map<string, Resolved>();
  const visiting = new Set<string>();
  const failed = new Set<string>();
  const changes = new Map<string, () => void>();
  const origin = (task: ExtractedTask, value: number | undefined): Bound | undefined => value === undefined || !Number.isFinite(value) ? undefined : {
    value, approximate: false, evidence: task.sourceSpan ? [task.sourceSpan] : [],
  };

  const solve = (id: string): Resolved => {
    if (resolved.has(id)) return resolved.get(id)!;
    const task = byId.get(id)!;
    if (visiting.has(id)) {
      failed.add(id);
      requireTimingReview(task, "These timing relationships form a cycle; confirm the order before scheduling.");
      return {};
    }
    visiting.add(id);
    const item = sourceById.get(id)!;
    const duration = interpretedWorkDuration(item, input, task.estimatedMinutes);
    const ownStart = origin(task, instant(task.fixedStartAt));
    const ownEnd = origin(task, instant(task.fixedEndAt));
    // A preserved AI-proposed anchor (e.g. "at 5" without AM/PM) must not
    // turn downstream travel into an apparently verified exact appointment.
    if (ownStart && task.fieldProvenance?.some((field) => field.path === "fixedStartAt" && field.origin === "inferred")) ownStart.approximate = true;
    if (ownEnd && task.fieldProvenance?.some((field) => field.path === "fixedEndAt" && field.origin === "inferred")) ownEnd.approximate = true;
    const checkpoint = task.responsibilityKind === "milestone" ? origin(task, instant(task.dueAt)) : undefined;
    const state: Resolved = { start: ownStart ?? checkpoint, end: ownEnd ?? checkpoint };
    const starts: Bound[] = state.start ? [state.start] : [];
    const ends: Bound[] = state.end ? [state.end] : [];
    const lower: Bound[] = [];
    const upper: Bound[] = [];
    const rationales: string[] = [];
    let arrivalPoint = item.kind === "milestone";
    let travel = false;
    const outgoing = linksById.get(id) ?? [];
    // Save the numeric interpretation even if its anchor date/time is not yet
    // known, so an event edit can resolve the chain without another AI call.
    if (!ownStart && outgoing.some((link) => link.mode === "exact" || link.arrival)) {
      task.schedulingConstraints = {
        ...task.schedulingConstraints,
        linkedTiming: {
          rules: outgoing.map((link) => ({
            taskId: link.relation.toId, boundary: link.fromBoundary,
            targetBoundary: link.toBoundary,
            offsetMinutes: link.minutes === 0 ? 0 : (link.relation.relation === "before" ? -1 : 1) * link.minutes,
            mode: link.mode, approximate: link.approximate || link.relation.strength === "soft",
          })),
          approximate: outgoing.some((link) => link.approximate || link.relation.strength === "soft") || Boolean(duration?.approximate),
          durationEstimated: Boolean(duration?.approximate),
          arrivalBuffer: outgoing.some((link) => link.arrival),
          unresolved: true,
        },
      };
    }
    for (const link of outgoing) {
      const target = solve(link.relation.toId);
      if (failed.has(link.relation.toId)) {
        failed.add(id);
        requireTimingReview(task, "A prerequisite has conflicting timing; confirm it before using this calculated time.");
        continue;
      }
      const targetTask = byId.get(link.relation.toId)!;
      const boundary = target[link.toBoundary]
        ?? (targetTask.responsibilityKind === "milestone" ? origin(targetTask, instant(targetTask.dueAt)) : undefined);
      if (!boundary) continue; // A valid dependency can wait for the scheduler.
      const sign = link.relation.relation === "before" ? -1 : 1;
      const derived: Bound = {
        value: boundary.value + sign * link.minutes * 60_000,
        approximate: boundary.approximate || link.approximate || link.relation.strength === "soft",
        evidence: [...boundary.evidence, link.evidence],
      };
      rationales.push(`${link.fromBoundary} ${link.minutes} minutes ${link.relation.relation} ${targetTask.title} (${link.toBoundary}), calculated from the cited relationship${derived.approximate ? "; approximate/preferred timing" : ""}.`);
      arrivalPoint ||= link.arrival;
      travel ||= link.travel;
      const addLimit = (value: Bound, mode: "latest" | "earliest") => {
        if (mode === "latest") {
          if (link.fromBoundary === "start" && !arrivalPoint) {
            if (duration) upper.push({ ...value, value: value.value + duration.minutes * 60_000, approximate: value.approximate || duration.approximate });
          } else upper.push(value);
        } else if (link.fromBoundary === "end" && !arrivalPoint) {
          if (duration) lower.push({ ...value, value: value.value - duration.minutes * 60_000, approximate: value.approximate || duration.approximate });
        } else lower.push(value);
      };
      if (link.mode === "exact") {
        (link.fromBoundary === "start" ? starts : ends).push(derived);
      } else {
        addLimit(derived, link.mode);
        if (link.relation.maximumLagMinutes !== undefined) {
          addLimit({ ...derived, value: boundary.value + sign * link.relation.maximumLagMinutes * 60_000 }, sign < 0 ? "earliest" : "latest");
        }
      }
    }

    const select = (values: Bound[]): Bound | undefined => {
      if (!values.length) return undefined;
      if (values.some((value) => value.value !== values[0].value)) {
        failed.add(id);
        requireTimingReview(task, "The stated timing constraints disagree; confirm the affected time.");
        return undefined;
      }
      return { ...values[0], approximate: values.some((value) => value.approximate), evidence: values.flatMap((value) => value.evidence) };
    };
    state.start = select(starts);
    state.end = select(ends);
    if (arrivalPoint && state.start) state.end = state.start;
    if (!arrivalPoint && duration) {
      if (state.end && !state.start) state.start = { ...state.end, value: state.end.value - duration.minutes * 60_000, approximate: state.end.approximate || duration.approximate };
      else if (state.start && !state.end) state.end = { ...state.start, value: state.start.value + duration.minutes * 60_000, approximate: state.start.approximate || duration.approximate };
      else if (state.start && state.end && !duration.approximate && state.end.value - state.start.value !== duration.minutes * 60_000) {
        failed.add(id);
        requireTimingReview(task, "The stated duration conflicts with the timing boundaries; confirm the duration or time.");
      }
    }
    state.latestEnd = upper.sort((a, b) => a.value - b.value)[0];
    state.earliestStart = lower.sort((a, b) => b.value - a.value)[0];
    if (arrivalPoint && !state.start) {
      // Choose the boundary as a review-only checkpoint proposal, so earlier
      // travel can be calculated even for "arrive at least N minutes early".
      state.start = state.latestEnd ?? state.earliestStart;
      state.end = state.start;
    }
    const min = state.earliestStart?.value;
    const max = state.latestEnd?.value;
    const due = instant(task.dueAt);
    if ((state.start && min !== undefined && state.start.value < min)
      || (state.end && max !== undefined && state.end.value > max)
      || (min !== undefined && max !== undefined && min + (duration?.minutes ?? 0) * 60_000 > max)
      || (state.end && due !== undefined && task.deadlineStrength === "hard" && !arrivalPoint && state.end.value > due)) {
      failed.add(id);
      requireTimingReview(task, "The timing relationships leave no feasible interval; review the conflicting boundaries.");
    }
    visiting.delete(id);
    if (failed.has(id)) {
      resolved.set(id, {});
      return {};
    }
    resolved.set(id, state);
    if (!outgoing.length || !rationales.length) return state;
    changes.set(id, () => {
      const rationale = rationales.join(" ");
      const evidence = [...(state.start?.evidence ?? []), ...(state.end?.evidence ?? []), ...(state.latestEnd?.evidence ?? []), ...(state.earliestStart?.evidence ?? [])];
      requireTimingReview(task, RELATIONSHIP_REVIEW_MESSAGE);
      const linkedTiming = task.schedulingConstraints?.linkedTiming;
      if (linkedTiming && state.start && state.end) {
        linkedTiming.unresolved = false;
        linkedTiming.approximate = state.start.approximate || state.end.approximate;
      }
      if (arrivalPoint && (state.start || state.latestEnd || state.earliestStart)) {
        const point = state.start ?? state.latestEnd ?? state.earliestStart!;
        // An arrival checkpoint has no invented active work or event duration.
        task.responsibilityKind = "milestone";
        task.taskType = "flexible";
        task.estimatedMinutes = undefined;
        task.minimumSessionMinutes = undefined;
        task.durationRange = undefined;
        task.fixedStartAt = undefined;
        task.fixedEndAt = undefined;
        task.occurrenceWindow = undefined;
        task.schedulingConstraints = linkedTiming ? { linkedTiming } : undefined;
        task.deadlineStrength = point.approximate ? "soft" : "hard";
        task.dueAt = new Date(point.value).toISOString();
        task.dueDate = formatInTimeZone(task.dueAt, input.timeZone, "yyyy-MM-dd");
        task.dueTime = formatInTimeZone(task.dueAt, input.timeZone, "HH:mm");
        provenance(task, ["dueAt", "dueDate", "dueTime"], evidence, `${rationale} AI-interpreted checkpoint; source presence and arithmetic checked, meaning requires confirmation.`);
      } else if (state.start && state.end && state.end.value > state.start.value && !ownStart) {
        const start = new Date(state.start.value).toISOString();
        const end = new Date(state.end.value).toISOString();
        // Estimated duration changes certainty, not the anchored placement.
        task.fixedStartAt = start;
        task.fixedEndAt = end;
        task.taskType = "fixed_time";
        task.splittable = false;
        task.occurrenceWindow = undefined;
        provenance(task, ["fixedStartAt", "fixedEndAt"], evidence, `${rationale} Uses the ${duration!.approximate ? "estimated" : "stated"} ${duration!.minutes}-minute duration.`);
        if (travel && !state.end.approximate) state.latestEnd = state.end;
      }
      if ((task.fixedStartAt || (arrivalPoint && task.dueAt)) && !item.reviewRequired) {
        task.missingInformation = task.missingInformation.filter((message) => message !== "Exact event start and end time are not specified.");
        if (!task.missingInformation.length) {
          task.reviewRequired = false;
          task.approved = true;
        }
      }
      const latest = state.latestEnd;
      const earliest = state.earliestStart;
      if (latest || earliest) {
        // Preserve the real deadline. Store a tighter derived planning window
        // separately (e.g. homework due at 3 PM, but finished before departure).
        const date = task.dueDate ?? item.occurrence?.date ?? input.currentLocalDate;
        const start = earliest?.value ?? fromZonedTime(`${input.currentLocalDate}T00:00:00`, input.timeZone).getTime();
        const end = latest?.value ?? due ?? fromZonedTime(`${date}T23:59:00`, input.timeZone).getTime();
        if (end <= start) {
          requireTimingReview(task, "The calculated work window has already passed or is empty; confirm the schedule.");
          return;
        }
        const approximate = Boolean(latest?.approximate || earliest?.approximate);
        const window: TemporalWindow = { start: new Date(start).toISOString(), end: new Date(end).toISOString(), label: approximate ? "Preferred window from approximate timing" : "Window calculated from a stated relationship", precision: approximate ? "approximate" : "exact" };
        const key = approximate ? "preferredDateWindows" : "allowedDateWindows";
        const existing = task.schedulingConstraints?.[key] ?? [];
        const intersections = key === "allowedDateWindows" && existing.length
          ? existing.flatMap((current) => {
            const a = Math.max(Date.parse(current.start), start);
            const b = Math.min(Date.parse(current.end), end);
            return b > a ? [{ ...window, start: new Date(a).toISOString(), end: new Date(b).toISOString() }] : [];
          })
          : [window];
        if (!intersections.length) {
          requireTimingReview(task, "The calculated timing conflicts with the stated availability window.");
          return;
        }
        task.schedulingConstraints = { ...task.schedulingConstraints, [key]: intersections };
        provenance(task, [`schedulingConstraints.${key}`], evidence, rationale);
      }
    });
    return state;
  };
  tasks.forEach((task) => solve(task.id!));
  changes.forEach((apply, id) => { if (!failed.has(id)) apply(); });
}
