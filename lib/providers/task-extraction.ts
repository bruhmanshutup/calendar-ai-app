import type {
  ExtractionInput,
  ExtractionResult,
} from "@/lib/domain/types";
import type { ProviderFailureReason } from "@/lib/domain/extraction-diagnostics";

export type TaskExtractionDiagnostics = {
  verificationMode?: "always" | "auto" | "off";
  verificationAttempted?: boolean;
  verificationSkipped?: boolean;
  verificationSucceeded?: boolean;
  verificationRiskScore?: number;
  verificationReasons?: string[];
};

export interface TaskExtractionProvider {
  extractTasks(input: ExtractionInput): Promise<ExtractionResult>;
  getDiagnostics?(): TaskExtractionDiagnostics | undefined;
}

export class TaskExtractionError extends Error {
  readonly code:
    | "INVALID_INPUT"
      | "PROVIDER_UNAVAILABLE"
      | "INVALID_PROVIDER_OUTPUT";
  readonly fallbackReason?: ProviderFailureReason;

  constructor(
    code: TaskExtractionError["code"],
    message: string,
    options?: ErrorOptions & { fallbackReason?: ProviderFailureReason },
  ) {
    super(message, options);
    this.name = "TaskExtractionError";
    this.code = code;
    this.fallbackReason = options?.fallbackReason;
  }
}
