import { describe, expect, it } from "vitest";
import type { ExtractionInput } from "../lib/domain/types";
import {
  buildLocalEvidenceHint,
  formatLocalEvidenceHint,
} from "../lib/providers/local-evidence";

function input(text: string): ExtractionInput {
  return {
    text,
    currentLocalDate: "2027-01-11",
    timeZone: "America/Chicago",
  };
}

describe("local evidence", () => {
  it("returns source-bound sentence and list-item boundaries", () => {
    const source =
      "Confirm the venue. Send the map afterward.\n- Bring two extension cords\n2. Print badges";
    const hint = buildLocalEvidenceHint(input(source));

    expect(hint.boundaries.map((item) => item.boundary)).toEqual([
      "sentence",
      "sentence",
      "list_item",
      "list_item",
    ]);
    for (const item of [...hint.boundaries, ...hint.phrases]) {
      expect(source.slice(item.start, item.end)).toBe(item.quote);
    }
  });

  it("finds mechanical date, time, and duration wording without resolving it", () => {
    const source =
      "The workshop is next Tuesday from 9 to 11 AM. Setup may take about an hour, while cleanup needs 30-45 minutes.";
    const hint = buildLocalEvidenceHint(input(source));
    const temporal = hint.phrases
      .filter((item) => item.lexicalClass === "date_or_time_phrase")
      .map((item) => item.quote);
    const durations = hint.phrases
      .filter((item) => item.lexicalClass === "duration_phrase")
      .map((item) => item.quote);

    expect(temporal).toEqual(
      expect.arrayContaining([expect.stringMatching(/next Tuesday/i), expect.stringMatching(/9 to 11 AM/i)]),
    );
    expect(durations).toEqual(
      expect.arrayContaining([expect.stringMatching(/about an hour/i), expect.stringMatching(/30-45 minutes/i)]),
    );
    expect(hint.phrases.some((item) => /2027|\+00:00/.test(item.quote))).toBe(false);
  });

  it("surfaces ordering, soft language, corrections, and uncertainty as lexical cues", () => {
    const source =
      "Ideally polish the handout after legal replies. Actually, scratch that; perhaps use the revised draft instead. Do not distribute the old copy.";
    const hint = buildLocalEvidenceHint(input(source));
    const byClass = (lexicalClass: (typeof hint.phrases)[number]["lexicalClass"]) =>
      hint.phrases
        .filter((item) => item.lexicalClass === lexicalClass)
        .map((item) => item.quote.toLowerCase());

    expect(byClass("soft_language_phrase")).toContain("ideally");
    expect(byClass("ordering_phrase")).toContain("after");
    expect(byClass("correction_phrase")).toEqual(
      expect.arrayContaining(["actually", "scratch that", "instead"]),
    );
    expect(byClass("negation_or_uncertainty_phrase")).toEqual(
      expect.arrayContaining(["perhaps", "do not"]),
    );
  });

  it("does not emit semantic task, event, or deadline classifications", () => {
    const serialized = formatLocalEvidenceHint(
      input("By Friday, join the call at 4 PM if possible."),
    );
    const hint = JSON.parse(serialized) as Record<string, unknown>;

    expect(hint.policy).toBe("lexical_source_evidence_only");
    expect(serialized).not.toMatch(/\"(?:taskType|dueDate|dueAt|fixedStartAt|dependencies)\"/);
    expect(serialized).not.toMatch(/\"(?:task|event|deadline|preference|dependency)\"\s*:/);
  });

  it("keeps offsets exact with Unicode punctuation", () => {
    const source = "Note—don’t send it yet. Maybe revise it tomorrow afternoon.";
    const hint = buildLocalEvidenceHint(input(source));

    for (const item of [...hint.boundaries, ...hint.phrases]) {
      expect(source.slice(item.start, item.end)).toBe(item.quote);
    }
    expect(hint.phrases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ quote: "don’t" }),
        expect.objectContaining({ quote: "tomorrow afternoon" }),
      ]),
    );
  });

  it("caps work and output for very large imports", () => {
    const repeated = "Maybe review this next Monday for about an hour.\n";
    const source = repeated.repeat(3_000);
    const hint = buildLocalEvidenceHint(input(source));

    expect(source.length).toBeGreaterThan(100_000);
    expect(hint.sourceTruncated).toBe(true);
    expect(hint.scannedCharacters).toBe(40_000);
    expect(hint.boundaries.length).toBeLessThanOrEqual(64);
    for (const lexicalClass of new Set(hint.phrases.map((item) => item.lexicalClass))) {
      expect(
        hint.phrases.filter((item) => item.lexicalClass === lexicalClass).length,
      ).toBeLessThanOrEqual(40);
    }
    expect(formatLocalEvidenceHint(input(source)).length).toBeLessThan(70_000);
  });
});
