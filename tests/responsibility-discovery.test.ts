import { describe, expect, it } from "vitest";

import {
  discoveryCoverageIssues,
  ensureCorrectedResponsibilitiesDiscovered,
  ensurePassivePrerequisitesDiscovered,
  ensureRequiredArrivalMilestonesDiscovered,
  normalizeDiscoveryTemporalKinds,
  responsibilityDiscoverySchema,
} from "../lib/providers/responsibility-discovery";

describe("responsibility discovery coverage", () => {
  it("lets explicit deadline wording override an event-like deliverable noun", () => {
    const deadline = "The presentation is due Thursday at 1 PM.";
    const occurrence = "The presentation happens Thursday at 1 PM.";
    const discovery = responsibilityDiscoverySchema.parse({
      responsibilities: [
        {
          id: "presentation-deadline",
          title: "Presentation",
          kind: "event",
          sourceText: deadline,
          sourceStart: 0,
          sourceEnd: deadline.length,
        },
        {
          id: "presentation-occurrence",
          title: "Presentation",
          kind: "event",
          sourceText: occurrence,
          sourceStart: deadline.length + 1,
          sourceEnd: deadline.length + 1 + occurrence.length,
        },
      ],
      globalInstructions: [],
      ignoredStatements: [],
    });

    const normalized = normalizeDiscoveryTemporalKinds(discovery);

    expect(normalized.responsibilities[0].kind).toBe("task");
    expect(normalized.responsibilities[1].kind).toBe("event");
  });

  it("requests a discovery repair when a passive actionable prerequisite was swallowed", () => {
    const source =
      "Order the parts once the enclosure design is finalized. Shipping takes three days.";
    const discovery = responsibilityDiscoverySchema.parse({
      responsibilities: [
        {
          id: "order-parts",
          title: "Order parts",
          kind: "task",
          sourceText: "Order the parts once the enclosure design is finalized.",
          sourceStart: 0,
          sourceEnd: 55,
        },
      ],
      globalInstructions: [],
      ignoredStatements: [],
    });

    expect(discoveryCoverageIssues(source, discovery)).toEqual([
      expect.stringMatching(/enclosure design/i),
    ]);
  });

  it("accepts the same prerequisite when it is independently discovered", () => {
    const source = "Order the parts once the enclosure design is finalized.";
    const discovery = responsibilityDiscoverySchema.parse({
      responsibilities: [
        {
          id: "order-parts",
          title: "Order parts",
          kind: "task",
          sourceText: source,
          sourceStart: 0,
          sourceEnd: source.length,
        },
        {
          id: "enclosure",
          title: "Finalize enclosure design",
          kind: "task",
          sourceText: "the enclosure design is finalized",
          sourceStart: 21,
          sourceEnd: 55,
        },
      ],
      globalInstructions: [],
      ignoredStatements: [],
    });

    expect(discoveryCoverageIssues(source, discovery)).toEqual([]);
  });

  it("restores an unambiguously stated passive prerequisite after discovery repair omits it", () => {
    const source =
      "Order the motor once the shaft diameter is finalized. Shipping takes four days.";
    const prerequisiteText = "once the shaft diameter is finalized";
    const discovery = responsibilityDiscoverySchema.parse({
      responsibilities: [
        {
          id: "order-motor",
          title: "Order motor",
          kind: "task",
          sourceText: source.slice(0, source.indexOf(".") + 1),
          sourceStart: 0,
          sourceEnd: source.indexOf(".") + 1,
        },
      ],
      globalInstructions: [],
      ignoredStatements: [
        {
          sourceText: prerequisiteText,
          reason: "Context only",
        },
      ],
    });

    const recovered = ensurePassivePrerequisitesDiscovered(source, discovery);
    const prerequisite = recovered.responsibilities.find(
      (item) => item.id !== "order-motor",
    );

    expect(prerequisite).toMatchObject({
      title: "Finalize shaft diameter",
      kind: "task",
      sourceText: prerequisiteText,
      sourceStart: source.indexOf(prerequisiteText),
      sourceEnd: source.indexOf(prerequisiteText) + prerequisiteText.length,
    });
    expect(recovered.ignoredStatements).toEqual([]);
    expect(discoveryCoverageIssues(source, recovered)).toEqual([]);
  });

  it("requests a milestone when lead time must be counted back from arrival", () => {
    const source =
      "Order the filters. Shipping takes 3-4 days, and we need the filters by next Wednesday.";
    const discovery = responsibilityDiscoverySchema.parse({
      responsibilities: [
        {
          id: "order-filters",
          title: "Order filters",
          kind: "task",
          sourceText: "Order the filters.",
          sourceStart: 0,
          sourceEnd: 18,
        },
      ],
      globalInstructions: [],
      ignoredStatements: [],
    });

    expect(discoveryCoverageIssues(source, discovery)).toEqual([
      expect.stringMatching(/arrival milestone/i),
    ]);
  });

  it("requests repair when a dated review action was treated as context only", () => {
    const source =
      "Get the draft mostly finished this weekend. I want to look at it Monday morning.";
    const discovery = responsibilityDiscoverySchema.parse({
      responsibilities: [
        {
          id: "draft",
          title: "Finish draft",
          kind: "task",
          sourceText: "Get the draft mostly finished this weekend.",
          sourceStart: 0,
          sourceEnd: 43,
        },
      ],
      globalInstructions: [],
      ignoredStatements: [],
    });

    expect(discoveryCoverageIssues(source, discovery)).toEqual([
      expect.stringMatching(/review\/check action/i),
    ]);
  });

  it("restores a corrected responsibility even when discovery swallowed it", () => {
    const source = `Professor: The presentation has been moved from Tuesday to Thursday at 1 PM. Slides still need to be sent to me the night before.

Student: Does that mean Wednesday at midnight?

Professor: Yes, but preferably earlier. Also, ignore my previous message saying the written summary was due Tuesday. That is now due Friday at 5 PM.`;
    const swallowedSlides = source.slice(source.indexOf("Slides"));
    const discovery = responsibilityDiscoverySchema.parse({
      responsibilities: [
        {
          id: "presentation",
          title: "Presentation",
          kind: "event",
          sourceText:
            "Professor: The presentation has been moved from Tuesday to Thursday at 1 PM.",
          sourceStart: 0,
          sourceEnd: 76,
        },
        {
          id: "slides",
          title: "Send slides",
          kind: "task",
          sourceText: swallowedSlides,
          sourceStart: source.indexOf("Slides"),
          sourceEnd: source.length,
        },
      ],
      globalInstructions: [],
      ignoredStatements: [],
    });

    const recovered = ensureCorrectedResponsibilitiesDiscovered(source, discovery);
    expect(recovered.responsibilities).toHaveLength(3);
    expect(recovered.responsibilities.at(-1)).toMatchObject({
      title: "Written Summary",
      kind: "task",
    });
  });

  it("expands an anaphoric corrected identity back to its named source span", () => {
    const source =
      "Send the slides Wednesday. Ignore my previous message saying the written summary was due Tuesday. That is now due Friday at 5 PM.";
    const anaphor = "That is now due Friday at 5 PM.";
    const discovery = responsibilityDiscoverySchema.parse({
      responsibilities: [
        {
          id: "slides",
          title: "Send slides",
          kind: "task",
          sourceText: "Send the slides Wednesday.",
          sourceStart: 0,
          sourceEnd: 26,
        },
        {
          id: "summary",
          title: "Written summary",
          kind: "task",
          sourceText: anaphor,
          sourceStart: source.indexOf(anaphor),
          sourceEnd: source.indexOf(anaphor) + anaphor.length,
        },
      ],
      globalInstructions: [],
      ignoredStatements: [],
    });

    const recovered = ensureCorrectedResponsibilitiesDiscovered(source, discovery);
    const summary = recovered.responsibilities.find(
      (responsibility) => responsibility.id === "summary",
    );
    expect(summary?.sourceText).toMatch(/written summary was due Tuesday/i);
    expect(source.slice(summary?.sourceStart, summary?.sourceEnd)).toBe(
      summary?.sourceText,
    );
  });

  it("guarantees a passive arrival milestone when stated lead time requires backward planning", () => {
    const source =
      "Order the bearings. Shipping usually takes 3–4 days, and we need the bearings by next Wednesday.";
    const discovery = responsibilityDiscoverySchema.parse({
      responsibilities: [
        {
          id: "order-bearings",
          title: "Order bearings",
          kind: "task",
          sourceText: "Order the bearings.",
          sourceStart: 0,
          sourceEnd: 19,
        },
      ],
      globalInstructions: [],
      ignoredStatements: [],
    });

    const recovered = ensureRequiredArrivalMilestonesDiscovered(
      source,
      discovery,
    );
    const milestone = recovered.responsibilities.find(
      (responsibility) => responsibility.kind === "milestone",
    );
    expect(milestone).toMatchObject({
      title: "Bearings arrival boundary",
      sourceText: "we need the bearings by next Wednesday",
    });
    expect(source.slice(milestone?.sourceStart, milestone?.sourceEnd)).toBe(
      milestone?.sourceText,
    );
  });
});
