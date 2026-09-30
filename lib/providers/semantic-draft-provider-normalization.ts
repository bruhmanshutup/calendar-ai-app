import { parseClockTime } from "@/lib/domain/date-interpretation";
import { specialTimingTaskIds } from "./ai-timing-calculator";
import type { SemanticDraft } from "./semantic-draft";

type PathSegment = string | "*";

const LOCAL_DATE_PATHS = new Set([
  "responsibilities.*.deadline.date",
  "responsibilities.*.occurrence.date",
  "responsibilities.*.constraints.earliestStart.date",
  "responsibilities.*.constraints.latestEnd.date",
  "responsibilities.*.constraints.allowedWindows.*.date",
  "responsibilities.*.constraints.preferredWindows.*.date",
  "responsibilities.*.recurrence.startDate",
  "responsibilities.*.recurrence.endDate",
  "blockedTimes.*.date",
]);

const LOCAL_TIME_PATHS = new Set([
  "responsibilities.*.deadline.time",
  "responsibilities.*.occurrence.startTime",
  "responsibilities.*.occurrence.endTime",
  "responsibilities.*.constraints.earliestStart.time",
  "responsibilities.*.constraints.latestEnd.time",
  "responsibilities.*.constraints.allowedWindows.*.startTime",
  "responsibilities.*.constraints.allowedWindows.*.endTime",
  "responsibilities.*.constraints.preferredWindows.*.startTime",
  "responsibilities.*.constraints.preferredWindows.*.endTime",
  "responsibilities.*.recurrence.exactTimes.*.time",
  "blockedTimes.*.startTime",
  "blockedTimes.*.endTime",
]);

const LOWERCASE_ENUM_PATHS = new Set([
  "responsibilities.*.kind",
  "responsibilities.*.deadline.strength",
  "responsibilities.*.recurrence.frequency",
  "responsibilities.*.recurrence.daysOfWeek.*",
  "responsibilities.*.recurrence.exactTimes.*.daysOfWeek.*",
  "responsibilities.*.planning.priority",
  "responsibilities.*.planning.category",
  "responsibilities.*.planning.energyDemand",
  "relations.*.relation",
  "relations.*.strength",
  "relations.*.timing",
  "relations.*.fromBoundary",
  "relations.*.toBoundary",
  "relations.*.mode",
]);

const normalizedPath = (path: PathSegment[]) => path.join(".");

function emptyOptionalOccurrence(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const timingFields = new Set([
    "date", "dateSourceText", "startTime", "endTime", "period",
  ]);
  return Object.entries(value).every(([key, child]) => {
    if (key === "confidence") {
      return typeof child === "number" && Number.isFinite(child) && child >= 0 && child <= 1;
    }
    return timingFields.has(key) && typeof child === "string" && child.trim() === "";
  });
}

function normalizeLocalClock(value: string, path: string): string {
  const trimmed = value.trim();
  if (/^noon$/i.test(trimmed)) return "12:00";
  // The semantic contract defines a deadline at midnight as the end of its
  // named due day. Other midnight occurrences remain untouched because their
  // date-side meaning can be ambiguous.
  if (/^midnight$/i.test(trimmed)) {
    return path.endsWith(".deadline.time") ? "23:59" : trimmed;
  }
  const seconds = /^(\d{1,2}):(\d{2}):00$/.exec(trimmed);
  const clock = seconds ? `${seconds[1]}:${seconds[2]}` : trimmed;
  if (
    !/^\d{1,2}:\d{2}$/.test(clock) &&
    !/^\d{1,2}(?::\d{2})?\s*(?:am|pm)$/i.test(clock)
  ) {
    return clock;
  }
  return parseClockTime(clock) ?? clock;
}

function normalizeValue(value: unknown, path: PathSegment[]): unknown {
  if (typeof value === "string") {
    const key = normalizedPath(path);
    if (LOCAL_DATE_PATHS.has(key)) return value.trim();
    if (LOCAL_TIME_PATHS.has(key)) return normalizeLocalClock(value, key);
    if (LOWERCASE_ENUM_PATHS.has(key)) return value.trim().toLocaleLowerCase();
    return value;
  }
  if (Array.isArray(value)) {
    // Keep null/invalid array entries. Dropping one could silently remove a
    // responsibility, relationship, evidence item, or scheduling constraint.
    return value.map((item) => normalizeValue(item, [...path, "*"]));
  }
  if (!value || typeof value !== "object") return value;

  const normalized: Record<string, unknown> = {};
  Object.entries(value).forEach(([key, child]) => {
    // Gemini sometimes serializes an absent optional property as null. If the
    // field is actually required, strict schema validation will still fail
    // because omitting it does not satisfy the required contract.
    if (child === null) return;
    normalized[key] = normalizeValue(child, [...path, key]);
  });
  // Untimed tasks may serialize an absent occurrence as blank fields plus
  // confidence. Remove only that empty optional object, never a partial date,
  // clock, period, source quote, or an event's missing timing.
  if (
    normalizedPath(path) === "responsibilities.*" &&
    normalized.kind === "task" &&
    emptyOptionalOccurrence(normalized.occurrence)
  ) {
    delete normalized.occurrence;
  }
  if (
    normalizedPath(path) === "responsibilities.*.planning" &&
    typeof normalized.sessionCount === "number" &&
    normalized.sessionCount < 2
  ) {
    delete normalized.sessionCount;
  }
  if (
    normalizedPath(path) === "responsibilities.*.planning" &&
    typeof normalized.estimatedMinutes === "number" &&
    normalized.estimatedMinutes <= 0
  ) {
    delete normalized.estimatedMinutes;
  }
  return normalized;
}

/**
 * Applies source-neutral JSON cleanup before the strict semantic-draft schema.
 * It never adds facts, drops array members, resolves dates, or changes counts.
 */
export function normalizeSemanticDraftProviderOutput(value: unknown): unknown {
  const normalized = normalizeValue(value, []);
  // Special dates/clocks are calculator outputs, not API inputs. In particular,
  // an empty occurrence date must not route a valid numeric relationship into
  // main-event calendar validation. Leave actual event anchors untouched.
  if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
    const draft = normalized as SemanticDraft;
    if (Array.isArray(draft.responsibilities) && draft.responsibilities.every((item) => item && typeof item === "object") &&
      Array.isArray(draft.relations) && draft.relations.every((relation) => relation && typeof relation === "object")) {
      const ids = specialTimingTaskIds(draft);
      draft.responsibilities.forEach((item) => { if (ids.has(item.id)) delete item.occurrence; });
    }
  }
  return normalized;
}
