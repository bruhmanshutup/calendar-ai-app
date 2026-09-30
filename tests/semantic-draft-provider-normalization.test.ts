import { describe, expect, it } from "vitest";

import { semanticDraftSchema } from "../lib/providers/semantic-draft";
import { normalizeSemanticDraftProviderOutput } from "../lib/providers/semantic-draft-provider-normalization";

const minimumDraft = () => ({
  responsibilities: [
    {
      id: "report",
      title: "Finish report",
      kind: "task",
      sourceText: "Finish the report.",
      confidence: 0.9,
      missingInformation: [],
      reviewRequired: false,
    },
  ],
  relations: [],
  blockedTimes: [],
  globalInstructions: [],
  ignoredStatements: [],
});

describe("semantic-draft provider normalization", () => {
  it.each([
    {},
    { date: "", dateSourceText: "", confidence: 1 },
    { date: "  ", dateSourceText: "\n", startTime: "", endTime: null, period: " ", confidence: 0.9 },
  ])("omits blank optional occurrence fields on a task while preserving its deadline (%j)", (occurrence) => {
    const draft = minimumDraft();
    const deadline = { date: "2026-09-01", strength: "hard", confidence: 1 };
    const original = {
      ...draft,
      responsibilities: [{ ...draft.responsibilities[0], deadline, occurrence }],
    };
    const normalized = normalizeSemanticDraftProviderOutput(original);
    const task = semanticDraftSchema.parse(normalized).responsibilities[0];
    expect(task.kind).toBe("task");
    expect(task.deadline).toEqual(deadline);
    expect(task.occurrence).toBeUndefined();
    expect(original.responsibilities[0].occurrence).toEqual(occurrence);
  });

  it.each([
    { date: "not-a-date", confidence: 1 },
    { date: "2026-02-30", confidence: 1 },
    { date: "", startTime: "09:00", confidence: 1 },
    { date: "", endTime: "10:00", confidence: 1 },
    { date: "", period: "morning", confidence: 1 },
    { date: "", dateSourceText: "next Tuesday", confidence: 1 },
    { date: "", confidence: 2 },
    { date: "", unexpectedTiming: "tomorrow", confidence: 1 },
  ])("retains invalid or partially specified timing for validation (%j)", (occurrence) => {
    const draft = minimumDraft();
    const normalized = normalizeSemanticDraftProviderOutput({
      ...draft,
      responsibilities: [{ ...draft.responsibilities[0], occurrence }],
    }) as typeof draft & { responsibilities: Array<{ occurrence?: unknown }> };
    expect(normalized.responsibilities[0].occurrence).toEqual(occurrence);
    expect(semanticDraftSchema.safeParse(normalized).success).toBe(false);
  });

  it("does not hide missing event timing", () => {
    const draft = minimumDraft();
    const normalized = normalizeSemanticDraftProviderOutput({
      ...draft,
      responsibilities: [{ ...draft.responsibilities[0], kind: "event", occurrence: { date: "", confidence: 1 } }],
    });
    expect(semanticDraftSchema.safeParse(normalized).success).toBe(false);
  });

  it("normalizes only mechanically equivalent optional values", () => {
    const draft = minimumDraft();
    const normalized = normalizeSemanticDraftProviderOutput({
      ...draft,
      responsibilities: [
        {
          ...draft.responsibilities[0],
          kind: "TASK",
          sourceStart: null,
          sourceEnd: null,
          factEvidence: null,
          occurrence: {
            date: " 2026-09-07 ",
            startTime: "9:15 PM",
            endTime: null,
            period: null,
            confidence: 0.9,
          },
          deadline: {
            date: "2026-09-09",
            time: "midnight",
            strength: "HARD",
            confidence: 0.95,
          },
          constraints: null,
          planning: {
            priority: " HIGH ",
            category: "SCHOOL",
            energyDemand: "MEDIUM",
          },
        },
      ],
    });

    expect(semanticDraftSchema.parse(normalized).responsibilities[0]).toMatchObject({
      kind: "task",
      occurrence: {
        date: "2026-09-07",
        startTime: "21:15",
        confidence: 0.9,
      },
      deadline: {
        date: "2026-09-09",
        time: "23:59",
        strength: "hard",
        confidence: 0.95,
      },
      planning: {
        priority: "high",
        category: "school",
        energyDemand: "medium",
      },
    });
  });

  it("does not conceal missing required values or invalid array members", () => {
    const draft = minimumDraft();
    expect(() =>
      semanticDraftSchema.parse(
        normalizeSemanticDraftProviderOutput({
          ...draft,
          responsibilities: [
            { ...draft.responsibilities[0], confidence: null },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      semanticDraftSchema.parse(
        normalizeSemanticDraftProviderOutput({
          ...draft,
          relations: [null],
        }),
      ),
    ).toThrow();
  });

  it("drops meaningless non-positive optional planning values", () => {
    const draft = minimumDraft();
    const normalized = normalizeSemanticDraftProviderOutput({
      ...draft,
      responsibilities: [
        {
          ...draft.responsibilities[0],
          planning: { estimatedMinutes: 0, sessionCount: 1 },
        },
      ],
    });

    expect(
      semanticDraftSchema.parse(normalized).responsibilities[0].planning,
    ).toEqual({});
  });
});
