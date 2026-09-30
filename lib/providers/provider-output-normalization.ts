import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { parseClockTime } from "@/lib/domain/date-interpretation";
import type { ExtractionInput } from "@/lib/domain/types";

type PathSegment = string | "*";

const LOCAL_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;
const COMPACT_OFFSET_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)([+-]\d{2})(\d{2})$/;

const DATE_TIME_PATHS = new Set([
  "tasks.*.dueAt",
  "tasks.*.fixedStartAt",
  "tasks.*.fixedEndAt",
  "tasks.*.completedAt",
  "tasks.*.cancelledAt",
  "tasks.*.dueWindow.start",
  "tasks.*.dueWindow.end",
  "tasks.*.occurrenceWindow.start",
  "tasks.*.occurrenceWindow.end",
  "tasks.*.schedulingConstraints.allowedDateWindows.*.start",
  "tasks.*.schedulingConstraints.allowedDateWindows.*.end",
  "tasks.*.schedulingConstraints.preferredDateWindows.*.start",
  "tasks.*.schedulingConstraints.preferredDateWindows.*.end",
  "tasks.*.recurrence.windowStart",
  "tasks.*.recurrence.windowEnd",
  "planningRules.blockedTimes.*.start",
  "planningRules.blockedTimes.*.end",
]);

const CLOCK_PATHS = new Set([
  "tasks.*.dueTime",
  "tasks.*.schedulingConstraints.allowedTimeWindows.*.start",
  "tasks.*.schedulingConstraints.allowedTimeWindows.*.end",
  "tasks.*.schedulingConstraints.preferredTimeWindows.*.start",
  "tasks.*.schedulingConstraints.preferredTimeWindows.*.end",
  "tasks.*.recurrence.timeRules.*.time",
  "tasks.*.recurrence.monthlyRules.*.times.*",
  "tasks.*.recurrence.dateOverrides.*.times.*",
  "planningRules.earliestWorkTime",
  "planningRules.latestWorkTime",
]);

function normalizedPath(path: PathSegment[]): string {
  return path.join(".");
}

function normalizedFraction(value: string | undefined): string {
  return (value ?? "").slice(0, 3).padEnd(3, "0");
}

/**
 * Converts a provider's offset-less local date-time into a real instant in the
 * workspace time zone. A round trip guards against invalid calendar dates and
 * nonexistent local times during daylight-saving transitions.
 */
function normalizeDateTime(value: string, timeZone: string): string {
  const trimmed = value.trim();
  const compactOffset = COMPACT_OFFSET_DATE_TIME.exec(trimmed);
  if (compactOffset) {
    return `${compactOffset[1]}${compactOffset[2]}:${compactOffset[3]}`;
  }

  const match = LOCAL_DATE_TIME.exec(trimmed);
  if (!match) return trimmed;

  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] ?? "0");
  if (hour > 23 || minute > 59 || second > 59) return trimmed;

  const localDateTime = `${match[1]}T${String(hour).padStart(2, "0")}:${String(
    minute,
  ).padStart(2, "0")}:${String(second).padStart(2, "0")}.${normalizedFraction(
    match[5],
  )}`;

  try {
    const instant = fromZonedTime(localDateTime, timeZone);
    if (Number.isNaN(instant.getTime())) return trimmed;
    const roundTrip = formatInTimeZone(
      instant,
      timeZone,
      "yyyy-MM-dd'T'HH:mm:ss.SSS",
    );
    return roundTrip === localDateTime ? instant.toISOString() : trimmed;
  } catch {
    return trimmed;
  }
}

function normalizeClock(value: string): string {
  const trimmed = value.trim();
  if (/^midnight$/i.test(trimmed)) return "00:00";
  if (/^noon$/i.test(trimmed)) return "12:00";
  if (
    !/^\d{1,2}:\d{2}$/i.test(trimmed) &&
    !/^\d{1,2}(?::\d{2})?\s*(?:am|pm)$/i.test(trimmed)
  ) {
    return trimmed;
  }
  return parseClockTime(trimmed) ?? trimmed;
}

function normalizeValue(
  value: unknown,
  path: PathSegment[],
  timeZone: string,
): unknown {
  if (typeof value === "string") {
    const key = normalizedPath(path);
    if (DATE_TIME_PATHS.has(key)) return normalizeDateTime(value, timeZone);
    if (CLOCK_PATHS.has(key)) return normalizeClock(value);
    return value;
  }

  if (Array.isArray(value)) {
    // A null array element may stand for a missing required item. Keep it so
    // strict validation can request a semantic repair rather than silently
    // changing task or constraint counts.
    return value.map((item) => normalizeValue(item, [...path, "*"], timeZone));
  }

  if (!value || typeof value !== "object") return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // Provider JSON commonly serializes absent optional properties as null.
    // Omitting those properties matches the domain schema's optional fields.
    if (child === null) continue;
    normalized[key] = normalizeValue(child, [...path, key], timeZone);
  }
  return normalized;
}

/**
 * Performs only mechanical, source-neutral cleanup before strict extraction
 * validation. It never adds tasks, changes task types, resolves ambiguous
 * dates, or changes dependency semantics.
 */
export function normalizeProviderExtractionOutput(
  value: unknown,
  input: Pick<ExtractionInput, "timeZone">,
): unknown {
  return normalizeValue(value, [], input.timeZone);
}
