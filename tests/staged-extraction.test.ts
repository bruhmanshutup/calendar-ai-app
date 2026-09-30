import { describe, expect, it } from "vitest";
import type { ExtractionInput, ExtractionResult } from "../lib/domain/types";
import {
  discoverResponsibilities,
  finalizeStagedExtraction,
} from "../lib/providers/staged-extraction";
import { task } from "./fixtures";

const input: ExtractionInput = {
  text: "Email the adviser by Friday. It should take about 20 minutes. Keep Saturday after 8 PM free.",
  currentLocalDate: "2026-08-29",
  timeZone: "America/Los_Angeles",
  sourceId: "test-source",
};

describe("staged extraction", () => {
  it("finishes when multiple responsibilities cite a shared quote with no unused occurrence", () => {
    const source = { ...input, text: "Read the brief and sketch the design." };
    const output = finalizeStagedExtraction(source, {
      tasks: [
        task({ id: "read", title: "Read the brief", sourceText: source.text }),
        task({ id: "sketch", title: "Sketch the design", sourceText: source.text }),
      ], ignoredStatements: [],
    }, { responsibilities: [], globalInstructions: [] });
    expect(output.tasks).toHaveLength(2);
    expect(output.tasks[0].sourceSpan?.quote).toBe(source.text);
    expect(output.tasks[1].sourceText).toBe(source.text);
  });

  it("uses repeated evidence occurrences in order and stops after the last one", () => {
    const quote = "Practice the exercise.";
    const source = { ...input, text: `${quote}\n${quote}` };
    const output = finalizeStagedExtraction(source, {
      tasks: [1,2,3].map(index=>task({id:`practice-${index}`,title:`Practice variation ${index}`,sourceText:quote})), ignoredStatements: [],
    }, { responsibilities: [], globalInstructions: [] });
    expect(output.tasks).toHaveLength(3);
    expect(output.tasks[0].sourceSpan?.start).toBe(0);
    expect(output.tasks[1].sourceSpan?.start).toBe(quote.length + 1);
    expect(output.tasks[2].sourceSpan).toBeUndefined();
  });

  it("discovers every responsibility in a compact deadline-and-meeting email", () => {
    const email: ExtractionInput = {
      text: `Hi Zach,
Just a reminder that your design proposal is due Friday, September 4 at 11:59 PM. Before then, please send me your preliminary CAD drawings by Wednesday afternoon so I can review them.

We’ll meet Thursday at 2 PM for about an hour to go over feedback. If possible, try to make any final edits Thursday evening so you aren’t rushing Friday night.

Thanks!`,
      currentLocalDate: "2026-08-29",
      timeZone: "America/Los_Angeles",
    };

    const discovery = discoverResponsibilities(email);

    expect(discovery.responsibilities).toHaveLength(4);
    expect(discovery.responsibilities.map((item) => item.span.quote)).toEqual([
      expect.stringContaining("design proposal is due"),
      expect.stringContaining("send me your preliminary CAD drawings"),
      expect.stringContaining("We’ll meet Thursday at 2 PM"),
      expect.stringContaining("make any final edits Thursday evening"),
    ]);
  });

  it("discovers source evidence before planning enrichment", () => {
    const discovery = discoverResponsibilities(input);

    expect(discovery.responsibilities).toHaveLength(1);
    expect(discovery.globalInstructions).toHaveLength(1);
    for (const span of [
      discovery.responsibilities[0].span,
      discovery.globalInstructions[0],
    ]) {
      expect(input.text.slice(span.start, span.end)).toBe(span.quote);
    }
  });

  it("keeps supplied facts separate from planning suggestions", () => {
    const result: ExtractionResult = {
      tasks: [
        task({
          id: "email",
          title: "Email the adviser",
          sourceText:
            "Email the adviser by Friday. It should take about 20 minutes.",
          dueDate: "2026-09-04",
          estimatedMinutes: 20,
          effortEstimateSource: "stated",
          reviewRequired: false,
          approved: true,
        }),
      ],
      ignoredStatements: [],
    };

    const staged = finalizeStagedExtraction(
      input,
      result,
      discoverResponsibilities(input),
    );
    const extracted = staged.tasks[0];

    expect(input.text.slice(extracted.sourceSpan!.start, extracted.sourceSpan!.end)).toBe(
      extracted.sourceSpan!.quote,
    );
    expect(
      extracted.fieldProvenance?.find((field) => field.path === "dueDate")
        ?.origin,
    ).toBe("explicit");
    expect(
      extracted.fieldProvenance?.find(
        (field) => field.path === "estimatedMinutes",
      )?.origin,
    ).toBe("explicit");
    expect(
      extracted.fieldProvenance?.find((field) => field.path === "energyDemand")
        ?.origin,
    ).toBe("inferred");
    expect(staged.interpretation).toMatchObject({
      discoveredResponsibilityCount: 1,
      explicitFieldCount: expect.any(Number),
      inferredFieldCount: expect.any(Number),
    });
  });

  it("does not make a task unschedulable only because duration was inferred", () => {
    const result: ExtractionResult = {
      tasks: [
        task({
          id: "email",
          title: "Email the adviser",
          sourceText: "Email the adviser by Friday.",
          effortEstimateSource: "heuristic",
          missingInformation: ["Confirm effort estimate"],
          reviewRequired: true,
          approved: false,
        }),
      ],
      ignoredStatements: [],
    };

    const [extracted] = finalizeStagedExtraction(
      input,
      result,
      discoverResponsibilities(input),
    ).tasks;

    expect(extracted).toMatchObject({
      reviewRequired: false,
      approved: true,
      missingInformation: [],
    });
    expect(
      extracted.fieldProvenance?.find(
        (field) => field.path === "estimatedMinutes",
      )?.origin,
    ).toBe("inferred");
  });

  it("labels named temporal windows as derivations of explicit source wording", () => {
    const windowInput: ExtractionInput = {
      text: "Please send the CAD drawings by Wednesday afternoon.",
      currentLocalDate: "2026-08-29",
      timeZone: "America/Los_Angeles",
    };
    const result: ExtractionResult = {
      tasks: [
        task({
          id: "cad",
          title: "Send the CAD drawings",
          sourceText: windowInput.text,
          dueDate: "2026-09-02",
          dueWindow: {
            start: "2026-09-02T19:00:00.000Z",
            end: "2026-09-03T00:00:00.000Z",
            label: "Wednesday afternoon",
            precision: "named_period",
          },
          schedulingConstraints: {
            preferredDateWindows: [
              {
                start: "2026-09-02T19:00:00.000Z",
                end: "2026-09-03T00:00:00.000Z",
                label: "Wednesday afternoon",
                precision: "named_period",
              },
            ],
          },
        }),
      ],
      ignoredStatements: [],
    };

    const [extracted] = finalizeStagedExtraction(
      windowInput,
      result,
      discoverResponsibilities(windowInput),
    ).tasks;

    expect(
      extracted.fieldProvenance?.find((field) => field.path === "dueWindow")
        ?.origin,
    ).toBe("derived");
    expect(
      extracted.fieldProvenance?.find(
        (field) =>
          field.path === "schedulingConstraints.preferredDateWindows",
      )?.origin,
    ).toBe("derived");
  });
});
