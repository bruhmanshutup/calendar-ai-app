import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
  FieldOrigin,
  FieldProvenance,
  SourceEvidenceSpan,
  TaskDependency,
} from "@/lib/domain/types";
import { analyzeNarrativeStructure } from "./narrative-structure";
import { parseStructuredLearningPlan } from "./structured-plan-recovery";
import { withTaskClassification } from "@/lib/domain/task-classification";

export type ResponsibilityDiscovery = {
  key: string;
  span: SourceEvidenceSpan;
  dependencies: TaskDependency[];
};

export type ExtractionDiscovery = {
  responsibilities: ResponsibilityDiscovery[];
  globalInstructions: SourceEvidenceSpan[];
};

function evidenceSpan(
  input: ExtractionInput,
  start: number,
  end: number,
): SourceEvidenceSpan {
  return {
    ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    start,
    end,
    quote: input.text.slice(start, end),
  };
}

function locateQuote(
  input: ExtractionInput,
  quote: string,
  from = 0,
): SourceEvidenceSpan | undefined {
  const exact = quote.trim();
  if (!exact) return undefined;
  let start = input.text.indexOf(exact, from);
  if (start < 0) start = input.text.indexOf(exact);
  return start < 0
    ? undefined
    : evidenceSpan(input, start, start + exact.length);
}

function dependencyFor(
  text: string,
  span: SourceEvidenceSpan,
): TaskDependency[] {
  if (/^\s*(?:before|beforehand|prior\s+to)\b/i.test(text)) {
    return [{ relation: "before", evidence: span }];
  }
  if (/^\s*(?:after|afterward|afterwards|once|then)\b/i.test(text)) {
    return [{ relation: "after", evidence: span }];
  }
  return [];
}

/** Stage 1: identify responsibility and global-rule evidence before enrichment. */
export function discoverResponsibilities(
  input: ExtractionInput,
): ExtractionDiscovery {
  const structured = parseStructuredLearningPlan(input.text);
  if (structured) {
    let cursor = 0;
    const responsibilities = structured.items.flatMap((item) => {
      const span = locateQuote(input, item.sourceText, cursor);
      if (!span) return [];
      cursor = span.end;
      return [
        {
          key: `week-${item.week}-day-${item.day}`,
          span,
          dependencies: dependencyFor(item.action, span),
        },
      ];
    });
    return { responsibilities, globalInstructions: [] };
  }

  let cursor = 0;
  const responsibilities: ResponsibilityDiscovery[] = [];
  const globalInstructions: SourceEvidenceSpan[] = [];
  analyzeNarrativeStructure(input.text).forEach((segment, index) => {
    const span = locateQuote(input, segment.text, cursor);
    if (!span) return;
    cursor = span.end;
    if (segment.role === "global_schedule_rule") {
      globalInstructions.push(span);
      return;
    }
    if (
      segment.role === "action" ||
      segment.role === "dependent_action" ||
      segment.role === "possible_multiple_actions" ||
      segment.role === "list_item"
    ) {
      responsibilities.push({
        key: `segment-${index + 1}`,
        span,
        dependencies: dependencyFor(segment.text, span),
      });
    }
  });
  return { responsibilities, globalInstructions };
}

function taskSpan(
  input: ExtractionInput,
  task: ExtractedTask,
  claimedSpans: Set<string>,
): SourceEvidenceSpan | undefined {
  if (
    task.sourceSpan &&
    input.text.slice(task.sourceSpan.start, task.sourceSpan.end) ===
      task.sourceSpan.quote
  ) {
    return task.sourceSpan;
  }
  const locateUnclaimedQuote = (quote: string): SourceEvidenceSpan | undefined => {
    const exact = quote.trim();
    if (!exact) return undefined;
    let from = 0;
    while (from <= input.text.length) {
      const span = locateQuote(input, exact, from);
      // locateQuote can wrap back to the first match for discovery callers.
      // An unclaimed-span scan must only move forward, or shared evidence
      // can revisit an already-claimed quote forever.
      if (!span || span.start < from) return undefined;
      const key = `${span.start}|${span.end}`;
      if (!claimedSpans.has(key)) return span;
      from = span.start + 1;
    }
    return undefined;
  };
  const whole = locateUnclaimedQuote(task.sourceText);
  if (whole) return whole;
  const sourceLines = task.sourceText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = sourceLines.length - 1; index >= 0; index -= 1) {
    const span = locateUnclaimedQuote(sourceLines[index]);
    if (span) return span;
  }
  return undefined;
}

function sourceStatesDuration(source: string): boolean {
  return /\b(?:for\s+)?(?:about\s+|around\s+|roughly\s+)?\d+(?:\.\d+)?\s*(?:minutes?|mins?|hours?|hrs?)\b|\b(?:for\s+)?(?:about\s+|around\s+|roughly\s+)?(?:an?|half|one|two|three)\s+(?:and\s+a\s+half\s+)?hours?\b/i.test(
    source,
  );
}

function sourceStatesPriority(source: string): boolean {
  return /\b(?:urgent|high\s+priority|low\s+priority|not\s+urgent|important)\b/i.test(
    source,
  );
}

function inferredProvenance(
  task: ExtractedTask,
  span: SourceEvidenceSpan | undefined,
): FieldProvenance[] {
  const evidence = span ? [span] : undefined;
  const entries: FieldProvenance[] = [
    { path: "title", origin: "explicit", evidence },
    {
      path: "taskType",
      origin: "derived",
      evidence,
      rationale: "Classified from the responsibility wording.",
    },
    {
      path: "priority",
      origin: sourceStatesPriority(task.sourceText) ? "explicit" : "inferred",
      evidence: sourceStatesPriority(task.sourceText) ? evidence : undefined,
    },
    { path: "category", origin: "inferred" },
    { path: "energyDemand", origin: "inferred" },
    { path: "splittable", origin: "inferred" },
  ];

  if (task.estimatedMinutes !== undefined) {
    const stated =
      task.effortEstimateSource === "stated" ||
      sourceStatesDuration(task.sourceText);
    entries.push({
      path: "estimatedMinutes",
      origin: stated ? "explicit" : "inferred",
      evidence: stated ? evidence : undefined,
      rationale: stated ? undefined : task.effortEstimateRationale,
    });
  }
  if (task.minimumSessionMinutes !== undefined) {
    entries.push({ path: "minimumSessionMinutes", origin: "inferred" });
  }
  if (task.dueDate) entries.push({ path: "dueDate", origin: "explicit", evidence });
  if (task.dueTime) entries.push({ path: "dueTime", origin: "explicit", evidence });
  if (task.dueAt) entries.push({ path: "dueAt", origin: "derived", evidence });
  if (task.dueWindow) {
    entries.push({
      path: "dueWindow",
      origin: "derived",
      evidence,
      rationale: `Resolved the named deadline period “${task.dueWindow.label}” without inventing an exact due time.`,
    });
  }
  if (task.fixedStartAt) {
    entries.push({ path: "fixedStartAt", origin: "explicit", evidence });
  }
  if (task.fixedEndAt) {
    entries.push({
      path: "fixedEndAt",
      origin: /\b(?:-|–|—|to|until|onward)\b/i.test(task.sourceText)
        ? "explicit"
        : "derived",
      evidence,
    });
  }
  if (task.recurrence) {
    entries.push({ path: "recurrence", origin: "explicit", evidence });
  }
  if (task.sequence) {
    entries.push({ path: "sequence", origin: "derived", evidence });
  }
  if (task.schedulingConstraints) {
    entries.push({
      path: "schedulingConstraints",
      origin: "explicit",
      evidence,
    });
    if (task.schedulingConstraints.preferredDateWindows?.length) {
      entries.push({
        path: "schedulingConstraints.preferredDateWindows",
        origin: "derived",
        evidence,
        rationale: "Resolved a dated soft preference into a scheduling window.",
      });
    }
  }
  return entries;
}

function mergeProvenance(
  generated: FieldProvenance[],
  existing: FieldProvenance[] | undefined,
): FieldProvenance[] {
  const byPath = new Map(generated.map((item) => [item.path, item]));
  existing?.forEach((item) => byPath.set(item.path, item));
  return [...byPath.values()];
}

function originCount(tasks: ExtractedTask[], origin: FieldOrigin): number {
  return tasks.reduce(
    (total, task) =>
      total +
      (task.fieldProvenance?.filter((field) => field.origin === origin).length ??
        0),
    0,
  );
}

/**
 * Stages 2–4: attach explicit evidence, reconcile it, then label planning-only
 * inferences. The final ExtractedTask shape remains backward compatible.
 */
export function finalizeStagedExtraction(
  input: ExtractionInput,
  result: ExtractionResult,
  discovery: ExtractionDiscovery,
  options: { addLocallyInferredDependencies?: boolean } = {},
): ExtractionResult {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const claimedSpans = new Set<string>();
  const tasks = result.tasks.flatMap((originalTask) => {
    if (originalTask.schedulingConstraints?.calculatedTiming) return [originalTask];
    const remainingMissing = originalTask.missingInformation.filter(
      (item) => !/^confirm effort estimate$/i.test(item.trim()),
    );
    const inferenceWasOnlyBlocker =
      originalTask.reviewRequired &&
      originalTask.missingInformation.length > 0 &&
      remainingMissing.length === 0;
    const task: ExtractedTask = inferenceWasOnlyBlocker
      ? {
          ...originalTask,
          missingInformation: [],
          reviewRequired: false,
          approved: true,
        }
      : originalTask;
    const span = taskSpan(input, task, claimedSpans);
    if (!span) {
      warnings.push(`Could not locate exact source evidence for “${task.title}”.`);
    }
    const key = span
      ? `${span.sourceId ?? "source"}|${span.start}|${span.end}|${task.title
          .trim()
          .toLocaleLowerCase()}|${JSON.stringify(task.recurrence ?? null)}`
      : undefined;
    if (key && seen.has(key)) {
      warnings.push(`Removed a duplicate interpretation of “${task.title}”.`);
      return [];
    }
    if (key) seen.add(key);
    if (span) claimedSpans.add(`${span.start}|${span.end}`);
    const dependencies = [
      ...(task.dependencies ?? []),
      ...(options.addLocallyInferredDependencies !== false && span
        ? dependencyFor(span.quote, span)
        : []),
    ].filter(
      (dependency, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.relation === dependency.relation &&
            candidate.taskId === dependency.taskId &&
            candidate.evidence?.start === dependency.evidence?.start,
        ) === index,
    );
    return [
      {
        ...withTaskClassification(task),
        sourceSpan: span,
        fieldProvenance: mergeProvenance(
          inferredProvenance(task, span),
          task.fieldProvenance,
        ),
        dependencies: dependencies.length ? dependencies : undefined,
      },
    ];
  });

  if (
    discovery.responsibilities.length > 0 &&
    discovery.responsibilities.length !== tasks.length
  ) {
    warnings.push(
      `Discovery found ${discovery.responsibilities.length} responsibility candidates; reconciliation produced ${tasks.length} tasks.`,
    );
  }

  return {
    ...result,
    tasks,
    interpretation: {
      discoveredResponsibilityCount: discovery.responsibilities.length,
      explicitFieldCount: originCount(tasks, "explicit"),
      derivedFieldCount: originCount(tasks, "derived"),
      inferredFieldCount: originCount(tasks, "inferred"),
      globalInstructions: discovery.globalInstructions,
      validationWarnings: [
        ...(result.interpretation?.validationWarnings ?? []),
        ...warnings.filter(
          (warning) =>
            !result.interpretation?.validationWarnings.includes(warning),
        ),
      ],
    },
  };
}
