import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
} from "@/lib/domain/types";
import { userDeadlineClockEvidence } from "./import-instruction-evidence";

export type HybridReconciliationIssueCode =
  | "unsupported_exact_time"
  | "temporal_role_conflict"
  | "exact_time_conflict"
  | "date_conflict"
  | "missing_supported_timing";

export type HybridReconciliationIssue = {
  code: HybridReconciliationIssueCode;
  message: string;
  reviewQuestion: string;
};

export type HybridTaskReconciliationDiagnostic = {
  semanticTaskIndex: number;
  title: string;
  localTaskIndexes: number[];
  status: "agree" | "review" | "semantic_only" | "local_ambiguous";
  issues: HybridReconciliationIssue[];
};

export type HybridReconciliationDiagnostics = {
  providerName?: string;
  comparedTaskCount: number;
  agreementCount: number;
  reviewFlagCount: number;
  unmatchedSemanticTaskCount: number;
  ignoredLocalTaskCount: number;
  taskDiagnostics: HybridTaskReconciliationDiagnostic[];
};

export type HybridReconciliationOutput = {
  result: ExtractionResult;
  diagnostics: HybridReconciliationDiagnostics;
};

type SourceRange = {
  start: number;
  end: number;
};

const EXACT_TIME =
  /\b(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[ap]\.?m\.?)?|\b(?:1[0-2]|0?[1-9])\s*[ap]\.?m\.?\b|\b(?:noon|midnight)\b/i;
const DATE_CUE =
  /\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/i;
const DEADLINE_CUE =
  /\b(?:due|deadline|submit|turn(?:ed)?\s+in|send|finish|complete)\b|\bby\s+(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d|noon|midnight)/i;
const EVENT_CUE =
  /\b(?:meeting|appointment|interview|reservation|flight|class|exam|quiz)\b|\bwe(?:'ll|\s+will)\s+meet\b|\bmeet(?:ing)?\s+with\b/i;

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tokens = (value: string) =>
  new Set(
    normalize(value)
      .split(" ")
      .filter((token) => token.length > 2),
  );

const tokenSimilarity = (left: string, right: string) => {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) intersection += 1;
  });
  return intersection / Math.min(leftTokens.size, rightTokens.size);
};

const taskRange = (input: ExtractionInput, task: ExtractedTask): SourceRange | undefined => {
  const span = task.sourceSpan;
  if (
    span &&
    Number.isInteger(span.start) &&
    Number.isInteger(span.end) &&
    span.start >= 0 &&
    span.end > span.start &&
    span.end <= input.text.length
  ) {
    return { start: span.start, end: span.end };
  }

  const exactIndex = input.text.indexOf(task.sourceText);
  if (exactIndex >= 0) {
    return { start: exactIndex, end: exactIndex + task.sourceText.length };
  }

  const lowerIndex = input.text.toLowerCase().indexOf(task.sourceText.toLowerCase());
  return lowerIndex >= 0
    ? { start: lowerIndex, end: lowerIndex + task.sourceText.length }
    : undefined;
};

const overlapScore = (left: SourceRange, right: SourceRange) => {
  const overlap = Math.max(0, Math.min(left.end, right.end) - Math.max(left.start, right.start));
  return overlap / Math.min(left.end - left.start, right.end - right.start);
};

const matchScore = (
  input: ExtractionInput,
  semanticTask: ExtractedTask,
  localTask: ExtractedTask,
) => {
  const semanticRange = taskRange(input, semanticTask);
  const localRange = taskRange(input, localTask);
  if (semanticRange && localRange) {
    const overlap = overlapScore(semanticRange, localRange);
    if (overlap > 0) return 0.7 + overlap * 0.3;
  }

  const semanticSource = normalize(semanticTask.sourceText);
  const localSource = normalize(localTask.sourceText);
  if (!semanticSource || !localSource) return 0;
  if (semanticSource === localSource) return 1;
  if (semanticSource.includes(localSource) || localSource.includes(semanticSource)) {
    return 0.82;
  }
  return tokenSimilarity(semanticTask.sourceText, localTask.sourceText) * 0.7;
};

const evidenceText = (input: ExtractionInput, task: ExtractedTask) => {
  const range = taskRange(input, task);
  const primary = range
    ? input.text.slice(range.start, range.end)
    : task.sourceSpan?.quote || task.sourceText;
  const labels = [
    task.dueWindow?.label,
    task.occurrenceWindow?.label,
    ...(task.schedulingConstraints?.allowedDateWindows ?? []).map(
      (window) => window.label,
    ),
    ...(task.schedulingConstraints?.preferredDateWindows ?? []).map(
      (window) => window.label,
    ),
  ].filter(
    (label): label is string =>
      Boolean(label) && input.text.toLowerCase().includes(label!.toLowerCase()),
  );
  const factEvidence = (task.fieldProvenance ?? []).flatMap((field) =>
    (field.evidence ?? []).flatMap((span) =>
      span.end > span.start &&
      span.end <= input.text.length &&
      input.text.slice(span.start, span.end) === span.quote
        ? [span.quote]
        : [],
    ),
  );
  return [primary, ...factEvidence, ...labels].join(" ");
};

const exactTiming = (task: ExtractedTask) =>
  task.dueTime || task.fixedStartAt ? true : task.dueWindow?.precision === "exact";

const explicitClock = (value: string) => EXACT_TIME.test(value);

const normalizeClock = (clock: string | undefined) => {
  if (!clock) return undefined;
  const match = clock.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return clock;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
};

const localClockFromInstant = (instant: string | undefined, timeZone: string) => {
  if (!instant || Number.isNaN(Date.parse(instant))) return undefined;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  return hour && minute ? `${hour === "24" ? "00" : hour}:${minute}` : undefined;
};

const taskClock = (task: ExtractedTask, timeZone: string) =>
  normalizeClock(task.dueTime) ?? localClockFromInstant(task.fixedStartAt, timeZone);

const taskDate = (task: ExtractedTask, timeZone: string) => {
  if (task.dueDate) return task.dueDate;
  if (!task.fixedStartAt || Number.isNaN(Date.parse(task.fixedStartAt))) return undefined;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(task.fixedStartAt));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return year && month && day ? `${year}-${month}-${day}` : undefined;
};

const temporalRole = (task: ExtractedTask) => {
  if (task.taskType === "fixed_time") return "event";
  if (task.dueDate || task.dueTime || task.dueAt || task.dueWindow) return "deadline";
  return "flexible";
};

const timingSignature = (task: ExtractedTask, timeZone: string) =>
  [temporalRole(task), taskDate(task, timeZone), taskClock(task, timeZone)].join("|");

const roleCue = (source: string) => {
  const deadline = DEADLINE_CUE.test(source);
  const event = EVENT_CUE.test(source);
  if (deadline === event) return undefined;
  return deadline ? "deadline" : "event";
};

const dedupeIssues = (issues: HybridReconciliationIssue[]) => {
  const seen = new Set<HybridReconciliationIssueCode>();
  return issues.filter((issue) => {
    if (seen.has(issue.code)) return false;
    seen.add(issue.code);
    return true;
  });
};

function calculatedTimingPaths(input: ExtractionInput, task: ExtractedTask): Set<string> {
  return new Set((task.fieldProvenance ?? []).filter((field) =>
    field.origin === "derived"
    && /calculated from the cited relationship/i.test(field.rationale ?? "")
    && Boolean(field.evidence?.length)
    && field.evidence!.every((span) => input.text.slice(span.start, span.end) === span.quote),
  ).map((field) => field.path));
}

const compareTasks = (
  input: ExtractionInput,
  semanticTask: ExtractedTask,
  localTask: ExtractedTask,
) => {
  const issues: HybridReconciliationIssue[] = [];
  const source = evidenceText(input, semanticTask);
  const semanticRole = temporalRole(semanticTask);
  const localRole = temporalRole(localTask);
  const sourceRole = roleCue(source);
  const hasSourceClock = explicitClock(source);
  const localRoleConfidence =
    localTask.fieldConfidence.taskType ?? localTask.confidence;
  const localDateConfidence =
    localTask.fieldConfidence.dueDate ?? localTask.confidence;
  const localClockConfidence =
    localTask.fieldConfidence.dueTime ?? localTask.confidence;

  if (
    semanticRole !== localRole &&
    semanticRole !== "flexible" &&
    localRole !== "flexible" &&
    localRoleConfidence >= 0.8 &&
    (sourceRole === localRole || (!sourceRole && hasSourceClock && (localRole !== "deadline" || DEADLINE_CUE.test(semanticTask.sourceText))))
  ) {
    issues.push({
      code: "temporal_role_conflict",
      message: `The semantic and local interpretations disagree about whether "${semanticTask.title}" is a deadline or scheduled event.`,
      reviewQuestion: "Confirm whether this is a deadline or a scheduled event.",
    });
  }

  const semanticClock = taskClock(semanticTask, input.timeZone);
  const localClock = taskClock(localTask, input.timeZone);
  if (
    semanticClock &&
    localClock &&
    semanticClock !== localClock &&
    hasSourceClock &&
    localClockConfidence >= 0.8
  ) {
    issues.push({
      code: "exact_time_conflict",
      message: `The semantic and local interpretations disagree about the exact time for "${semanticTask.title}".`,
      reviewQuestion: "Confirm the exact task time.",
    });
  }

  const semanticDate = taskDate(semanticTask, input.timeZone);
  const localDate = taskDate(localTask, input.timeZone);
  if (
    semanticDate &&
    localDate &&
    semanticDate !== localDate &&
    DATE_CUE.test(source) &&
    localDateConfidence >= 0.8
  ) {
    issues.push({
      code: "date_conflict",
      message: `The semantic and local interpretations disagree about the date for "${semanticTask.title}".`,
      reviewQuestion: "Confirm the task date.",
    });
  }

  if (
    semanticRole === "flexible" &&
    localRole !== "flexible" &&
    localRoleConfidence >= 0.8 &&
    sourceRole === localRole
  ) {
    issues.push({
      code: "missing_supported_timing",
      message: `The source contains task timing for "${semanticTask.title}" that is absent from the semantic interpretation.`,
      reviewQuestion: "Confirm how the stated date or time applies to this task.",
    });
  } else if (
    !exactTiming(semanticTask) &&
    exactTiming(localTask) &&
    hasSourceClock &&
    localClockConfidence >= 0.8 &&
    semanticRole === localRole
  ) {
    issues.push({
      code: "missing_supported_timing",
      message: `The source contains an exact time for "${semanticTask.title}" that is absent from the semantic interpretation.`,
      reviewQuestion: "Confirm how the stated time applies to this task.",
    });
  }

  const calculated = calculatedTimingPaths(input, semanticTask);
  const calculatedClock = calculated.has("fixedStartAt") || calculated.has("dueAt");
  return dedupeIssues(issues).filter((issue) => {
    if (calculatedClock && (issue.code === "exact_time_conflict" || issue.code === "date_conflict" || issue.code === "temporal_role_conflict")) return false;
    if (calculated.size && issue.code === "missing_supported_timing") return false;
    return true;
  });
};

const unsupportedSemanticTiming = (
  input: ExtractionInput,
  task: ExtractedTask,
): HybridReconciliationIssue[] => {
  if (userDeadlineClockEvidence(input, task) && !task.fixedStartAt) return [];
  const calculated = calculatedTimingPaths(input, task);
  if (!exactTiming(task) || calculated.has("fixedStartAt") || calculated.has("dueAt") || explicitClock(evidenceText(input, task))) return [];
  // The compiler already asks for confirmation of this retained proposal.
  // Do not add a second warning claiming its clock is absent altogether.
  const proposedAnchor = task.fixedStartAt && task.reviewRequired && !task.approved
    && task.fieldProvenance?.some((field) => field.path === "fixedStartAt" && field.origin === "inferred"
      && Boolean(field.evidence?.length)
      && field.evidence!.every((span) => input.text.slice(span.start, span.end) === span.quote));
  if (proposedAnchor) return [];
  return [
    {
      code: "unsupported_exact_time",
      message: `The semantic interpretation assigned an exact time to "${task.title}", but no exact time appears in its source evidence.`,
      reviewQuestion: "Confirm the exact time; it does not appear in the source text.",
    },
  ];
};

const addReviewQuestions = (task: ExtractedTask, issues: HybridReconciliationIssue[]) => {
  if (!issues.length) return task;
  const missingInformation = [...task.missingInformation];
  issues.forEach(({ reviewQuestion }) => {
    if (!missingInformation.some((item) => normalize(item) === normalize(reviewQuestion))) {
      missingInformation.push(reviewQuestion);
    }
  });
  return {
    ...task,
    missingInformation,
    reviewRequired: true,
    approved: false,
  };
};

/**
 * Reconciles a semantic model result with deterministic parser evidence.
 *
 * The semantic result remains authoritative for task identity and meaning. The
 * local result is intentionally unable to add, remove, merge, rename, or retime
 * tasks; it can only make a disagreement visible for human review.
 */
export const reconcileHybridExtraction = (
  input: ExtractionInput,
  semanticResult: ExtractionResult,
  localResult: ExtractionResult,
  providerName?: string,
): HybridReconciliationOutput => {
  const scores = localResult.tasks.map((localTask) =>
    semanticResult.tasks.map((semanticTask) =>
      matchScore(input, semanticTask, localTask),
    ),
  );
  const matchedSemanticByLocal = scores.map((row) =>
    row
      .map((score, semanticTaskIndex) => ({ score, semanticTaskIndex }))
      .filter(({ score }) => score >= 0.72)
      .map(({ semanticTaskIndex }) => semanticTaskIndex),
  );
  const broadLocalIndexes = new Set(
    matchedSemanticByLocal
      .map((matches, localTaskIndex) => ({ matches, localTaskIndex }))
      .filter(({ matches }) => matches.length > 1)
      .map(({ localTaskIndex }) => localTaskIndex),
  );

  const diagnostics: HybridTaskReconciliationDiagnostic[] = [];
  const warnings: string[] = [];
  const reconciledTasks = semanticResult.tasks.map((semanticTask, semanticTaskIndex) => {
    if (semanticTask.schedulingConstraints?.calculatedTiming) {
      diagnostics.push({ semanticTaskIndex, title: semanticTask.title, localTaskIndexes: [], status: "semantic_only", issues: [] });
      return semanticTask;
    }
    const candidates = scores
      .map((row, localTaskIndex) => ({
        localTaskIndex,
        score: row[semanticTaskIndex] ?? 0,
      }))
      .filter(
        ({ localTaskIndex, score }) =>
          score >= 0.72 && !broadLocalIndexes.has(localTaskIndex),
      )
      .sort((left, right) => right.score - left.score);
    const localTaskIndexes = candidates.map(({ localTaskIndex }) => localTaskIndex);
    const hasBroadLocalMatch = scores.some(
      (row, localTaskIndex) =>
        broadLocalIndexes.has(localTaskIndex) &&
        (row[semanticTaskIndex] ?? 0) >= 0.72,
    );
    let issues = unsupportedSemanticTiming(input, semanticTask);
    let status: HybridTaskReconciliationDiagnostic["status"] = "semantic_only";

    if (candidates.length) {
      const signatures = new Set(
        candidates.map(({ localTaskIndex }) =>
          timingSignature(localResult.tasks[localTaskIndex], input.timeZone),
        ),
      );
      if (signatures.size === 1) {
        issues = dedupeIssues([
          ...issues,
          ...compareTasks(
            input,
            semanticTask,
            localResult.tasks[candidates[0].localTaskIndex],
          ),
        ]);
        status = issues.length ? "review" : "agree";
      } else {
        // Conflicting local duplicates are evidence that the local pass is
        // unreliable, not a reason to mutate or distrust the semantic result.
        status = issues.length ? "review" : "local_ambiguous";
      }
    } else if (hasBroadLocalMatch) {
      status = issues.length ? "review" : "local_ambiguous";
    } else if (issues.length) {
      status = "review";
    }

    issues.forEach((issue) => warnings.push(issue.message));
    diagnostics.push({
      semanticTaskIndex,
      title: semanticTask.title,
      localTaskIndexes,
      status,
      issues,
    });
    return addReviewQuestions(semanticTask, issues);
  });

  const previousWarnings = semanticResult.interpretation?.validationWarnings ?? [];
  const validationWarnings = [...previousWarnings];
  warnings.forEach((warning) => {
    if (!validationWarnings.includes(warning)) validationWarnings.push(warning);
  });
  const result: ExtractionResult = {
    ...semanticResult,
    tasks: reconciledTasks,
    ...(semanticResult.interpretation
      ? {
          interpretation: {
            ...semanticResult.interpretation,
            validationWarnings,
          },
        }
      : {}),
  };

  const matchedLocalIndexes = new Set(
    diagnostics.flatMap((diagnostic) => diagnostic.localTaskIndexes),
  );
  return {
    result,
    diagnostics: {
      providerName,
      comparedTaskCount: diagnostics.filter(
        (diagnostic) => diagnostic.localTaskIndexes.length > 0,
      ).length,
      agreementCount: diagnostics.filter((diagnostic) => diagnostic.status === "agree")
        .length,
      reviewFlagCount: diagnostics.filter((diagnostic) => diagnostic.issues.length > 0)
        .length,
      unmatchedSemanticTaskCount: diagnostics.filter(
        (diagnostic) => diagnostic.status === "semantic_only",
      ).length,
      ignoredLocalTaskCount: localResult.tasks.filter(
        (_, index) => broadLocalIndexes.has(index) || !matchedLocalIndexes.has(index),
      ).length,
      taskDiagnostics: diagnostics,
    },
  };
};
