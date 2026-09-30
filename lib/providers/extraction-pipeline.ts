import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
  SourceEvidenceSpan,
} from "@/lib/domain/types";
import type {
  ExtractionFallbackReason,
  ExtractionPipelineReport,
} from "@/lib/domain/extraction-diagnostics";
import type { ExtractionMode } from "@/lib/domain/workspace-state";
import { recoverConcreteFormattedTasks } from "./format-recovery";
import { recoverFlexibleRecurrences } from "./flexible-recurrence-recovery";
import { applyExplicitDayAgendaScaffolding } from "./explicit-day-agenda-recovery";
import { reconcileHybridExtraction } from "./hybrid-reconciliation";
import { MockTaskExtractionProvider } from "./mock-extraction";
import { recoverExplicitOverdueTasks } from "./overdue-recovery";
import { recoverTimedRecurrences } from "./recurrence-recovery";
import {
  discoverResponsibilities,
  finalizeStagedExtraction,
  type ExtractionDiscovery,
} from "./staged-extraction";
import {
  prepareStructuredPlanExtractionInput,
  recoverStructuredLearningPlan,
} from "./structured-plan-recovery";
import {
  TaskExtractionError,
  type TaskExtractionProvider,
} from "./task-extraction";
import { recoverTemporalRoles } from "./temporal-role-recovery";
import { isStraightforwardLocalExtraction } from "./extraction-strategy";
import { markdownScheduleEvidence } from "./table-evidence";
import { prepareGlobalInstructions } from "@/lib/domain/global-instructions";
import { annotateImportEvidence } from "./import-instruction-evidence";
import { withResultClassifications } from "@/lib/domain/task-classification";

export type SemanticProviderName = "gemini" | "openai";
export type { ExtractionPipelineReport } from "@/lib/domain/extraction-diagnostics";

export type ExtractionPipelineOutput = {
  result: ExtractionResult;
  extractionMode: ExtractionMode;
  report: ExtractionPipelineReport;
};

export type ExtractionPipelineOptions = {
  semanticProviderName?: SemanticProviderName;
  semanticProvider?: TaskExtractionProvider;
  localProvider?: TaskExtractionProvider;
  allowLocalFallback?: boolean;
  /** Single-pass provider mode: no local interpretation or reconciliation. */
  architecture?: "hybrid" | "direct";
};

const FALLBACK_REVIEW_ITEM =
  "AI interpretation was unavailable; verify the task type, dates, times, and relationships.";
const FALLBACK_WARNING =
  "The configured AI interpreter was unavailable, so this import used the deterministic local fallback.";

function appendWarning(result: ExtractionResult, warning: string): ExtractionResult {
  if (!result.interpretation) return result;
  if (result.interpretation.validationWarnings.includes(warning)) return result;
  return {
    ...result,
    interpretation: {
      ...result.interpretation,
      validationWarnings: [...result.interpretation.validationWarnings, warning],
    },
  };
}

function requireFallbackReview(task: ExtractedTask): ExtractedTask {
  const missingInformation = [...task.missingInformation];
  if (!missingInformation.includes(FALLBACK_REVIEW_ITEM)) {
    missingInformation.push(FALLBACK_REVIEW_ITEM);
  }
  return {
    ...task,
    approved: false,
    reviewRequired: true,
    missingInformation,
  };
}

function removeEmbeddedContinuationTasks(result: ExtractionResult): ExtractionResult {
  const normalized = result.tasks.map((task) => ({
    task,
    source: task.sourceText.replace(/\s+/g, " ").trim().toLocaleLowerCase(),
  }));
  const tasks = normalized
    .filter(({ task, source }) => {
      const isContinuation = /^(?:it|this|that|these|those)\b/i.test(source);
      if (!isContinuation) return true;
      return !normalized.some(({ task: other, source: otherSource }) =>
        other !== task && otherSource.length > source.length && otherSource.includes(source),
      );
    })
    .map(({ task }) => task);
  return tasks.length === result.tasks.length ? result : { ...result, tasks };
}

/**
 * Legacy deterministic enrichment, used only when no semantic provider is
 * available. It intentionally excludes narrative-scheduling-recovery because
 * that module encoded example-specific task names and dates.
 */
export async function runLocalFallbackPipeline(
  input: ExtractionInput,
  extracted: ExtractionResult,
): Promise<ExtractionResult> {
  const withOverdueRecovery = await recoverExplicitOverdueTasks(input, extracted);
  const withTimedRecurrences = await recoverTimedRecurrences(
    input,
    withOverdueRecovery,
  );
  const withFlexibleRecurrences = await recoverFlexibleRecurrences(
    input,
    withTimedRecurrences,
  );
  const withFormattedRecovery = await recoverConcreteFormattedTasks(
    input,
    withFlexibleRecurrences,
  );
  const withStructuredPlan = recoverStructuredLearningPlan(
    input,
    withFormattedRecovery,
  );
  return recoverTemporalRoles(input, withStructuredPlan);
}

function semanticEvidenceInput(input: ExtractionInput): ExtractionInput {
  // Structured learning plans need their exact Week/Day row map. Ordinary
  // prose goes to the semantic provider unchanged: duplicating it as parser-
  // generated evidence made the model prompt noisier and less reliable.
  const structuredInput = prepareStructuredPlanExtractionInput({
    ...input,
    structureHint: undefined,
  });
  const tableEvidence = markdownScheduleEvidence(input.text);
  const structuredPlanHint = /\bweek\s+\d+\b|\bday\s+\d+\b/i.test(input.text)
    ? structuredInput.structureHint
    : undefined;
  const hints = [structuredPlanHint, tableEvidence].filter(
    (hint): hint is string => Boolean(hint),
  );
  return {
    ...input,
    structureHint: hints.length ? hints.join("\n") : undefined,
  };
}

function semanticDiscovery(
  input: ExtractionInput,
  result: ExtractionResult,
): ExtractionDiscovery {
  const claimedSpans = new Set<string>();
  const responsibilities = result.tasks.flatMap((task, index) => {
    let span: SourceEvidenceSpan | undefined;
    if (
      task.sourceSpan &&
      input.text.slice(task.sourceSpan.start, task.sourceSpan.end) ===
        task.sourceSpan.quote
    ) {
      span = task.sourceSpan;
    } else {
      let from = 0;
      while (from <= input.text.length) {
        const start = input.text.indexOf(task.sourceText, from);
        if (start < 0) break;
        const candidate = {
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
          start,
          end: start + task.sourceText.length,
          quote: task.sourceText,
        };
        const key = `${candidate.start}|${candidate.end}`;
        if (!claimedSpans.has(key)) {
          span = candidate;
          break;
        }
        from = start + 1;
      }
    }
    if (!span) return [];
    claimedSpans.add(`${span.start}|${span.end}`);
    return [
      {
        key: task.id ?? `semantic-${index + 1}`,
        span,
        dependencies: task.dependencies ?? [],
      },
    ];
  });
  return {
    responsibilities,
    globalInstructions: result.interpretation?.globalInstructions ?? [],
  };
}

/**
 * AI decides responsibility identity and meaning. The local pass is used as
 * role-neutral prompt evidence, a disagreement detector, and an explicit
 * availability fallback; it can never rewrite a successful AI interpretation.
 */
export async function runExtractionPipeline(
  input: ExtractionInput,
  options: ExtractionPipelineOptions = {},
): Promise<ExtractionPipelineOutput> {
  const prepared = prepareGlobalInstructions(input);
  if (!prepared.rules.length) return runCoreExtractionPipeline(input, options);
  if (!options.semanticProvider || !options.semanticProviderName) {
    throw new TaskExtractionError("PROVIDER_UNAVAILABLE", "Global instructions require the AI interpreter. Configure an AI provider and retry; no unfiltered tasks were imported.");
  }
  const output = await runCoreExtractionPipeline(prepared.input, { ...options, allowLocalFallback: false });
  const trace = output.result.interpretation;
  // Control-only cards are never responsibilities, even if the AI emits one.
  const controls = new Set(prepared.spans.map((span) => span.quote.trim()));
  output.result.tasks = output.result.tasks.filter((task) => !controls.has(task.sourceText.trim())).map(task => annotateImportEvidence(prepared.input, task));
  output.result.interpretation = {
    discoveredResponsibilityCount: output.result.tasks.length,
    explicitFieldCount: trace?.explicitFieldCount ?? 0,
    derivedFieldCount: trace?.derivedFieldCount ?? 0,
    inferredFieldCount: trace?.inferredFieldCount ?? 0,
    globalInstructions: [...prepared.spans, ...(trace?.globalInstructions ?? [])],
    validationWarnings: trace?.validationWarnings ?? [],
  };
  return output;
}

async function runCoreExtractionPipeline(
  input: ExtractionInput,
  options: ExtractionPipelineOptions,
): Promise<ExtractionPipelineOutput> {
  const architecture = options.architecture ?? "hybrid";
  if (architecture === "direct" && options.semanticProviderName && options.semanticProvider) {
    try {
      const result = removeEmbeddedContinuationTasks(await options.semanticProvider.extractTasks(input));
      return {
        result: withResultClassifications(result),
        extractionMode: `${options.semanticProviderName}-direct`,
        report: {
          semanticProvider: options.semanticProviderName,
          semanticProviderAttempted: true,
          semanticProviderUsed: true,
          localEvidenceUsed: false,
          localFallbackUsed: false,
          comparedTaskCount: 0,
          reconciliationReviewCount: 0,
          ...(options.semanticProvider.getDiagnostics?.() ?? {}),
        },
      };
    } catch (error) {
      throw error instanceof TaskExtractionError
        ? error
        : new TaskExtractionError("PROVIDER_UNAVAILABLE", "Task extraction is temporarily unavailable.", { cause: error });
    }
  }
  const localProvider = options.localProvider ?? new MockTaskExtractionProvider();
  const localPromise = localProvider.extractTasks(input);
  const semanticProviderName = options.semanticProviderName;
  let semanticFailure: TaskExtractionError | undefined;
  let fallbackReason: ExtractionFallbackReason | undefined =
    semanticProviderName && !options.semanticProvider
      ? "provider_not_configured"
      : undefined;

  if (semanticProviderName && options.semanticProvider) {
    let semanticResult: ExtractionResult | undefined;
    try {
      semanticResult = await options.semanticProvider.extractTasks(
        semanticEvidenceInput(input),
      );
    } catch (error) {
      semanticFailure =
        error instanceof TaskExtractionError
          ? error
          : new TaskExtractionError(
              "PROVIDER_UNAVAILABLE",
              "The configured AI interpreter is currently unavailable.",
              { cause: error, fallbackReason: "provider_unavailable" },
            );
      fallbackReason =
        semanticFailure.fallbackReason
          ? semanticFailure.fallbackReason
          : semanticFailure.code === "INVALID_PROVIDER_OUTPUT"
            ? "invalid_provider_output"
            : "provider_unavailable";
      // The source and local result remain available when the network provider
      // is unavailable or returns invalid structured output.
    }
    if (semanticResult) {
      const localResult = await localPromise;
      const reconciled = reconcileHybridExtraction(
        input,
        semanticResult,
        localResult,
        semanticProviderName,
      );
      const calculatedTasks = semanticResult.tasks.filter((task) => task.schedulingConstraints?.calculatedTiming);
      const mainResult = { ...reconciled.result, tasks: reconciled.result.tasks.filter((task) => !task.schedulingConstraints?.calculatedTiming) };
      const continuationSafe = removeEmbeddedContinuationTasks(mainResult);
      const withAgendaScaffolding = input.globalInstructions?.trim() ? continuationSafe : applyExplicitDayAgendaScaffolding(
        input,
        continuationSafe,
        localResult,
      );
      // Recurring clock rules and exclusions are explicit source facts. Recover
      // them from the user's text even when the semantic provider returns a
      // vague quota recurrence or accidentally treats excluded days as active.
      const withTimedRecurrences = input.globalInstructions?.trim() ? withAgendaScaffolding : await recoverTimedRecurrences(
        input,
        withAgendaScaffolding,
      );
      // Week/Day rows are explicit sequence facts, not semantic guesses. Apply
      // the same lossless recovery after a successful provider response as we
      // do for the local fallback so AI success cannot remove the plan's shared
      // sequence group or its selectable/explicit start-date anchor.
      const withStructuredPlan = input.globalInstructions?.trim() ? withTimedRecurrences : recoverStructuredLearningPlan(
        input,
        withTimedRecurrences,
      );
      const combined = { ...withStructuredPlan, tasks: [...withStructuredPlan.tasks, ...calculatedTasks] };
      const discovery = semanticDiscovery(input, combined);
      const finalized = finalizeStagedExtraction(
          input,
          combined,
          discovery,
          { addLocallyInferredDependencies: false },
        );
      return {
        result: withResultClassifications(finalized),
        extractionMode: `${semanticProviderName}-hybrid`,
        report: {
          semanticProvider: semanticProviderName,
          semanticProviderAttempted: true,
          semanticProviderUsed: true,
          localEvidenceUsed: true,
          localFallbackUsed: false,
          comparedTaskCount: reconciled.diagnostics.comparedTaskCount,
          reconciliationReviewCount:
            reconciled.diagnostics.reviewFlagCount,
          ...(options.semanticProvider.getDiagnostics?.() ?? {}),
        },
      };
    }
  }

  if (semanticProviderName && options.allowLocalFallback === false) {
    throw (
      semanticFailure ??
      new TaskExtractionError(
        "PROVIDER_UNAVAILABLE",
        "The configured AI interpreter is not available.",
        {
          fallbackReason:
            fallbackReason === "provider_not_configured"
              ? "provider_not_configured"
              : "provider_unavailable",
        },
      )
    );
  }

  const localResult = await localPromise;
  const localIsStraightforward = isStraightforwardLocalExtraction(
    input,
    localResult,
  );
  let recovered = await runLocalFallbackPipeline(input, localResult);
  const isProviderFallback = Boolean(semanticProviderName);
  if (isProviderFallback && !localIsStraightforward) {
    recovered = {
      ...recovered,
      tasks: recovered.tasks.map(requireFallbackReview),
    };
  }
  let result = finalizeStagedExtraction(
    input,
    recovered,
    discoverResponsibilities(input),
  );
  if (isProviderFallback) result = appendWarning(result, FALLBACK_WARNING);
  result = withResultClassifications(result);

  return {
    result,
    extractionMode: isProviderFallback ? "local-fallback" : "local",
    report: {
      ...(semanticProviderName ? { semanticProvider: semanticProviderName } : {}),
      semanticProviderAttempted: Boolean(options.semanticProvider),
      semanticProviderUsed: false,
      localEvidenceUsed: false,
      localFallbackUsed: isProviderFallback,
      comparedTaskCount: 0,
      reconciliationReviewCount: 0,
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(options.semanticProvider?.getDiagnostics?.() ?? {}),
    },
  };
}
