const TIME_RANGE =
  /^\s*\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to)\s*\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\s*$/i;

const cleanCell = (value: string | undefined) =>
  value
    ?.replace(/<br\s*\/?>/gi, " ")
    .replace(/[*_~\`]/g, "")
    .replace(/&#x?A0;|&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const parseRow = (line: string) =>
  line
    .trim()
    .slice(1, -1)
    .split("|")
    .map((cell) => cleanCell(cell) ?? "");

const isSeparator = (cells: string[]) =>
  cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));

const isHeading = (line: string) => {
  const match = /^\s*\*{1,2}([^*\n]+)\*{1,2}\s*$/.exec(line);
  return match?.[1].trim();
};

/**
 * Convert Markdown schedule rows into role-neutral, lossless evidence.
 * Some exports put the first timetable row before the separator row and have
 * no headers. Preserve the date heading and every non-empty cell, then let
 * the semantic provider decide which cell is the course, room, or instructor.
 */
export function markdownScheduleEvidence(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const evidence: string[] = [];
  let heading: string | undefined;
  let table: string[][] = [];

  const flush = () => {
    if (table.length < 2) {
      table = [];
      return;
    }
    const separatorIndex = table.findIndex(isSeparator);
    if (separatorIndex < 0 || separatorIndex > 1 || table[0].length < 2) {
      table = [];
      return;
    }
    const first = table[0];
    const header = first.map((cell) => cell.toLocaleLowerCase());
    const headerLooksLabeled =
      !TIME_RANGE.test(first[0] ?? "") &&
      header.some((cell) => /time|when/.test(cell)) &&
      header.some((cell) => /what|task|activity|event/.test(cell));
    const rows = headerLooksLabeled ? table.slice(separatorIndex + 1) : table;
    const timeIndex = headerLooksLabeled
      ? header.findIndex((cell) => /time|when/.test(cell))
      : 0;
    const activityIndex = headerLooksLabeled
      ? header.findIndex((cell) => /what|task|activity|event/.test(cell))
      : 1;
    rows.forEach((cells) => {
      const time = cells[timeIndex] ?? "";
      const nonEmpty = cells.filter(Boolean);
      if (!TIME_RANGE.test(time) || nonEmpty.length < 2) return;
      const prefix = heading ? "heading: " + heading + "; " : "";
      if (headerLooksLabeled) {
        const activity = cells[activityIndex] ?? "";
        const locationIndex = header.findIndex((cell) => /where|location|place/.test(cell));
        const location = locationIndex >= 0 ? cells[locationIndex] : "";
        evidence.push(
          "- " + prefix + "time: " + time + "; activity: " + activity + ";" +
          (location ? " location: " + location + ";" : "") +
          " cells: [" + nonEmpty.join(" | ") + "]",
        );
      } else {
        evidence.push("- " + prefix + "time: " + time + "; cells: [" + nonEmpty.join(" | ") + "]");
      }
    });
    table = [];
  };

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    const nextHeading = isHeading(line);
    if (nextHeading) {
      flush();
      heading = nextHeading;
      return;
    }
    if (/^\|.*\|$/.test(line)) {
      table.push(parseRow(line));
      return;
    }
    flush();
  });
  flush();

  return evidence.length
    ? [
        "Lossless schedule-table evidence (source quotes remain authoritative; cell positions are preserved and not semantically assigned):",
        ...evidence,
      ].join("\n")
    : undefined;
}
