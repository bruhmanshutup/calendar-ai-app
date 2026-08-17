const DAY_HEADING =
  /^\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s*\((today|tomorrow)\))?\s*:?[\s]*$/i;

const CLOCK_AT_START =
  /^\s*(?:after\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;

export function dayAgendaDateContext(line: string): string | undefined {
  const match = DAY_HEADING.exec(line);
  return match?.[2] ?? match?.[1];
}

/**
 * Identifies a line-oriented agenda whose weekday headings provide the date
 * context for clock-prefixed rows. These inputs are already structurally
 * explicit and should not be rewritten by narrative-specific heuristics.
 */
export function isExplicitDayAgenda(text: string): boolean {
  let hasDayHeading = false;
  let timedRowsUnderHeading = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (dayAgendaDateContext(line)) {
      hasDayHeading = true;
      continue;
    }
    if (hasDayHeading && CLOCK_AT_START.test(line)) {
      timedRowsUnderHeading += 1;
    }
  }

  return hasDayHeading && timedRowsUnderHeading >= 1;
}
