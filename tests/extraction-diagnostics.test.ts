import { describe, expect, it } from "vitest";
import {
  extractionFallbackNotice,
  type ExtractionPipelineReport,
} from "../lib/domain/extraction-diagnostics";

function report(
  patch: Partial<ExtractionPipelineReport> = {},
): ExtractionPipelineReport {
  return {
    semanticProvider: "gemini",
    semanticProviderAttempted: true,
    semanticProviderUsed: false,
    localEvidenceUsed: false,
    localFallbackUsed: true,
    comparedTaskCount: 0,
    reconciliationReviewCount: 0,
    ...patch,
  };
}

describe("extraction fallback notices", () => {
  it("explains an output-token fallback and recommends a smaller import", () => {
    const notice = extractionFallbackNotice(
      report({ fallbackReason: "output_token_limit" }),
    );

    expect(notice?.title).toContain("size limit");
    expect(notice?.detail).toContain("local parsing");
    expect(notice?.action).toContain("split");
  });

  it("does not show a fallback notice after successful AI interpretation", () => {
    expect(
      extractionFallbackNotice(
        report({
          semanticProviderUsed: true,
          localFallbackUsed: false,
          fallbackReason: undefined,
        }),
      ),
    ).toBeUndefined();
  });
});
