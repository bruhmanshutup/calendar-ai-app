import type {
  ExtractionInput,
  ExtractionResult,
} from "@/lib/domain/types";

export interface TaskExtractionProvider {
  extractTasks(input: ExtractionInput): Promise<ExtractionResult>;
}

export class TaskExtractionError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "PROVIDER_UNAVAILABLE"
    | "INVALID_PROVIDER_OUTPUT";

  constructor(
    code: TaskExtractionError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TaskExtractionError";
    this.code = code;
  }
}

