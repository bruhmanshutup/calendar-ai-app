import { describe, expect, it } from "vitest";
import { extractionModeImportSummary } from "../app/components/planpilot-provider";

describe("extraction mode import summaries", () => {
  it.each([
    ["gemini-hybrid", "Gemini"],
    ["openai-hybrid", "OpenAI"],
  ] as const)("explains the %s division of responsibility", (mode, provider) => {
    const summary = extractionModeImportSummary(mode);

    expect(summary).toContain(`${provider} interpreted task meaning`);
    expect(summary).toContain("local source checks verified");
  });

  it("makes an AI outage explicit for local fallback", () => {
    const summary = extractionModeImportSummary("local-fallback");

    expect(summary).toContain("AI interpretation was unavailable");
    expect(summary).toContain("Review uncertain");
    expect(summary).toContain("before scheduling");
  });

  it("describes ordinary local interpretation without claiming an outage", () => {
    const summary = extractionModeImportSummary("local");

    expect(summary).toContain("Local interpretation completed");
    expect(summary).not.toContain("AI interpretation was unavailable");
  });
});
