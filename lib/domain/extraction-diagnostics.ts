export type ExtractionFallbackReason =
  | "provider_not_configured"
  | "provider_unavailable"
  | "request_timed_out"
  | "rate_limited"
  | "output_token_limit"
  | "empty_provider_output"
  | "malformed_provider_output"
  | "schema_validation_failed"
  | "invalid_provider_output";

export type ProviderFailureReason = ExtractionFallbackReason;

export type ExtractionPipelineReport = {
  semanticProvider?: "gemini" | "openai";
  semanticProviderAttempted: boolean;
  semanticProviderUsed: boolean;
  localEvidenceUsed: boolean;
  localFallbackUsed: boolean;
  comparedTaskCount: number;
  reconciliationReviewCount: number;
  fallbackReason?: ExtractionFallbackReason;
  verificationMode?: "always" | "auto" | "off";
  verificationAttempted?: boolean;
  verificationSkipped?: boolean;
  verificationSucceeded?: boolean;
  verificationRiskScore?: number;
  verificationReasons?: string[];
};

export type ExtractionFallbackNotice = {
  title: string;
  detail: string;
  action: string;
};

export function extractionFallbackNotice(
  report: ExtractionPipelineReport | undefined,
): ExtractionFallbackNotice | undefined {
  if (!report?.localFallbackUsed) return undefined;

  switch (report.fallbackReason) {
    case "output_token_limit":
      return {
        title: "The AI response reached its size limit",
        detail:
          "The model stopped before it could return a complete interpretation, so PlanPilot used local parsing for this import.",
        action:
          "For better AI interpretation, split a large plan into smaller sections, such as one to three weeks per import.",
      };
    case "rate_limited":
      return {
        title: "The AI provider is temporarily rate-limited",
        detail:
          "PlanPilot used local parsing because the provider could not accept this request right now.",
        action: "Review the result or retry the same import in a few minutes.",
      };
    case "request_timed_out":
      return {
        title: "The AI request took too long",
        detail:
          "PlanPilot stopped waiting and used local parsing so your import was not lost.",
        action:
          "Retry the import, or split a long document into smaller sections if it times out again.",
      };
    case "provider_not_configured":
      return {
        title: "The AI provider is not configured",
        detail:
          "PlanPilot used local parsing because no usable server-side AI configuration was available.",
        action: "Check the provider and API-key configuration before retrying.",
      };
    case "empty_provider_output":
      return {
        title: "The AI provider returned an empty response",
        detail:
          "There was no usable interpretation to validate, so PlanPilot used local parsing.",
        action: "Review the result and retry if important details are missing.",
      };
    case "malformed_provider_output":
      return {
        title: "The AI response was incomplete or malformed",
        detail:
          "PlanPilot could not safely read the returned data and used local parsing instead.",
        action:
          "Review the result; splitting a large or complex document may produce a cleaner response.",
      };
    case "schema_validation_failed":
      return {
        title: "The AI response failed validation",
        detail:
          "Some returned fields did not match PlanPilot's required task format, so local parsing was used.",
        action: "Review task types, dates, times, and relationships before scheduling.",
      };
    case "invalid_provider_output":
      return {
        title: "The AI response could not be validated",
        detail:
          "PlanPilot rejected an unsafe or incomplete interpretation and used local parsing instead.",
        action: "Review the result and retry if important details are missing.",
      };
    case "provider_unavailable":
    default:
      return {
        title: "The AI provider was unavailable",
        detail:
          "PlanPilot used local parsing so you could continue without losing the imported text.",
        action: "Review the result or retry when the provider is available.",
      };
  }
}

export function extractionFailureMessage(
  reason: ExtractionFallbackReason | undefined,
  providerMessage: string,
): string {
  switch (reason) {
    case "output_token_limit":
      return "The AI response reached its size limit before returning a complete interpretation. Split this import into smaller sections and try again.";
    case "rate_limited":
      return "The AI provider is temporarily rate-limited. Wait a few minutes and try again.";
    case "request_timed_out":
      return "The AI request took too long. Retry it, or split a long import into smaller sections.";
    case "provider_not_configured":
      return "The AI provider is not configured correctly. Check the server-side provider and API key before retrying.";
    case "empty_provider_output":
      return "The AI provider returned an empty response. Your text is still here; please try again.";
    case "malformed_provider_output":
      return "The AI response was incomplete or malformed. Split a large or complex import into smaller sections and try again.";
    case "schema_validation_failed":
      return "The AI response did not match PlanPilot's required task format. No tasks were imported; revise or split the text and try again.";
    case "invalid_provider_output":
      return "The AI response could not be validated safely. No tasks were imported; please try again.";
    case "provider_unavailable":
      return "The AI provider is currently unavailable. No fallback was used and no tasks were imported; please try again later.";
    default:
      return providerMessage;
  }
}
