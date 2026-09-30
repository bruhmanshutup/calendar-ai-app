import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
  FieldProvenance,
  SourceEvidenceSpan,
} from "@/lib/domain/types";
import { isExplicitDayAgenda } from "./day-agenda";

const CLOCK = String.raw`\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)`;
const CLOCKED_ROW = new RegExp(
  String.raw`^\s*(?:after\s+)?${CLOCK}(?:\s+(?:onward|onwards))?(?:\s*(?:-|–|—|to)\s*${CLOCK})?\s*(?:[-–—:]\s*)?(.*?)\s*$`,
  "i",
);
const EXPLICIT_END = new RegExp(
  String.raw`(?:\b(?:onward|onwards)\b|${CLOCK}\s*(?:-|–|—|to)\s*${CLOCK})`,
  "i",
);
const PROTECTED_FREE_TIME =
  /^(?:keep(?:\s+.+)?\s+free|free|do not schedule|don't schedule)$/i;

type AgendaRow = {
  span: SourceEvidenceSpan;
  action: string;
  protectedTime: boolean;
  hasExplicitEnd: boolean;
};

type AgendaScaffold = {
  row: AgendaRow;
  localTask: ExtractedTask;
};

const normalized = (value: string) =>
  value
    .toLocaleLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const validSpan = (
  input: ExtractionInput,
  span: SourceEvidenceSpan | undefined,
): span is SourceEvidenceSpan =>
  Boolean(
    span &&
      span.start >= 0 &&
      span.end > span.start &&
      span.end <= input.text.length &&
      input.text.slice(span.start, span.end) === span.quote,
  );

function agendaRows(input: ExtractionInput): AgendaRow[] {
  const rows: AgendaRow[] = [];
  let underDayHeading = false;

  for (const match of input.text.matchAll(/[^\r\n]+/g)) {
    const quote = match[0];
    const trimmed = quote.trim();
    if (/^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s*\((?:today|tomorrow)\))?\s*:?$/i.test(trimmed)) {
      underDayHeading = true;
      continue;
    }
    if (!underDayHeading) continue;
    const clocked = CLOCKED_ROW.exec(trimmed);
    if (!clocked) continue;
    const action = clocked[1].trim();
    if (!action) continue;
    const start = match.index;
    rows.push({
      span: {
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        start,
        end: start + quote.length,
        quote,
      },
      action,
      protectedTime:
        /^after\s+/i.test(trimmed) && PROTECTED_FREE_TIME.test(action),
      hasExplicitEnd: EXPLICIT_END.test(trimmed),
    });
  }

  return rows;
}

function overlap(left: SourceEvidenceSpan, right: SourceEvidenceSpan): number {
  return Math.max(
    0,
    Math.min(left.end, right.end) - Math.max(left.start, right.start),
  );
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalized(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalized(right).split(" ").filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const common = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return common / new Set([...leftTokens, ...rightTokens]).size;
}

function rowMatchScore(
  input: ExtractionInput,
  task: ExtractedTask,
  row: AgendaRow,
): number {
  if (validSpan(input, task.sourceSpan)) {
    const shared = overlap(task.sourceSpan, row.span);
    if (shared > 0) {
      return 120 + shared / Math.min(task.sourceSpan.quote.length, row.span.quote.length);
    }
  }

  const taskSource = normalized(task.sourceText);
  const rowSource = normalized(row.span.quote);
  const action = normalized(row.action);
  const title = normalized(task.title);
  if (taskSource === rowSource) return 110;
  if (taskSource === action) return 105;
  if (
    taskSource &&
    action &&
    (taskSource.includes(action) || action.includes(taskSource))
  ) {
    return 90;
  }
  if (title === action) return 85;
  return 55 + tokenSimilarity(task.title, row.action) * 25;
}

function mapLocalScaffolds(
  input: ExtractionInput,
  localResult: ExtractionResult,
  rows: AgendaRow[],
): AgendaScaffold[] {
  const taskRows = rows.filter((row) => !row.protectedTime);
  const candidates = localResult.tasks.filter(
    (task) =>
      task.taskType === "fixed_time" &&
      Boolean(task.fixedStartAt) &&
      Boolean(task.fixedEndAt),
  );
  const pairs = taskRows
    .flatMap((row, rowIndex) =>
      candidates.map((localTask, taskIndex) => ({
        rowIndex,
        taskIndex,
        score: rowMatchScore(input, localTask, row),
      })),
    )
    .filter(({ score }) => score >= 65)
    .sort((left, right) => right.score - left.score);
  const assignedRows = new Map<number, number>();
  const assignedTasks = new Set<number>();
  pairs.forEach(({ rowIndex, taskIndex }) => {
    if (assignedRows.has(rowIndex) || assignedTasks.has(taskIndex)) return;
    assignedRows.set(rowIndex, taskIndex);
    assignedTasks.add(taskIndex);
  });

  return taskRows.flatMap((row, rowIndex) => {
    const taskIndex = assignedRows.get(rowIndex);
    return taskIndex === undefined
      ? []
      : [{ row, localTask: candidates[taskIndex] }];
  });
}

const TEMPORAL_PROVENANCE_PATHS = new Set([
  "taskType",
  "deadlineStrength",
  "dueDate",
  "dueTime",
  "dueAt",
  "dueWindow",
  "occurrenceWindow",
  "fixedStartAt",
  "fixedEndAt",
  "estimatedMinutes",
  "durationRange",
  "minimumSessionMinutes",
  "recurrence",
  "schedulingConstraints",
  "schedulingConstraints.allowedTimeWindows",
  "schedulingConstraints.allowedDateWindows",
  "schedulingConstraints.preferredTimeWindows",
  "schedulingConstraints.preferredDateWindows",
]);

function agendaProvenance(
  task: ExtractedTask,
  scaffold: AgendaScaffold,
): FieldProvenance[] {
  const evidence = [scaffold.row.span];
  const retained = (task.fieldProvenance ?? []).filter(
    ({ path }) =>
      !TEMPORAL_PROVENANCE_PATHS.has(path) &&
      !path.startsWith("schedulingConstraints.") &&
      !path.startsWith("recurrence."),
  );
  return [
    ...retained,
    {
      path: "taskType",
      origin: "derived",
      evidence,
      rationale: "The responsibility is an entry in an explicit timed agenda.",
    },
    { path: "fixedStartAt", origin: "explicit", evidence },
    {
      path: "fixedEndAt",
      origin: scaffold.row.hasExplicitEnd ? "explicit" : "derived",
      evidence,
      ...(!scaffold.row.hasExplicitEnd
        ? {
            rationale:
              "Bounded by the next agenda entry or the default agenda duration.",
          }
        : {}),
    },
    {
      path: "estimatedMinutes",
      origin: scaffold.row.hasExplicitEnd ? "explicit" : "derived",
      evidence,
      ...(!scaffold.row.hasExplicitEnd
        ? { rationale: "Calculated from the fixed agenda interval." }
        : {}),
    },
  ];
}

const resolvedAgendaUncertainty = (item: string) =>
  /(?:confirm.*(?:task type|scheduled event|(?:exact|task|stated).*(?:date|time)|effort estimate)|fixed event end time|no deadline was stated|clarify date or time)/i.test(
    item,
  );

function applyScaffold(
  semanticTask: ExtractedTask,
  scaffold: AgendaScaffold,
): ExtractedTask {
  const { localTask, row } = scaffold;
  const start = new Date(localTask.fixedStartAt ?? "").getTime();
  const end = new Date(localTask.fixedEndAt ?? "").getTime();
  const minutes = Math.max(1, Math.round((end - start) / 60_000));
  const missingInformation = semanticTask.missingInformation.filter(
    (item) => !resolvedAgendaUncertainty(item),
  );
  const ready = missingInformation.length === 0;

  return {
    ...semanticTask,
    taskType: "fixed_time",
    deadlineStrength: undefined,
    dueDate: undefined,
    dueTime: undefined,
    dueAt: undefined,
    dueWindow: undefined,
    occurrenceWindow: undefined,
    fixedStartAt: localTask.fixedStartAt,
    fixedEndAt: localTask.fixedEndAt,
    estimatedMinutes: minutes,
    durationRange: undefined,
    effortEstimateSource: row.hasExplicitEnd ? "stated" : "heuristic",
    effortEstimateRationale: row.hasExplicitEnd
      ? "Calculated from the stated agenda interval."
      : "Bounded by the next agenda entry or the default agenda duration.",
    minimumSessionMinutes: Math.min(
      localTask.minimumSessionMinutes ?? minutes,
      minutes,
    ),
    schedulingConstraints: undefined,
    recurrence: undefined,
    confidence: Math.max(semanticTask.confidence, 0.95),
    fieldConfidence: {
      ...semanticTask.fieldConfidence,
      taskType: 0.99,
      dueDate: undefined,
      dueTime: undefined,
      estimatedMinutes: row.hasExplicitEnd ? 0.99 : 0.8,
      recurrence: undefined,
    },
    missingInformation,
    sourceText: row.span.quote,
    sourceSpan: row.span,
    fieldProvenance: agendaProvenance(semanticTask, scaffold),
    reviewRequired: ready ? false : semanticTask.reviewRequired,
    approved: ready ? true : semanticTask.approved,
  };
}

function mergeBlockedTimes(
  semanticResult: ExtractionResult,
  localResult: ExtractionResult,
): ExtractionResult["planningRules"] {
  const localBlockedTimes = localResult.planningRules?.blockedTimes ?? [];
  const semanticBlockedTimes = (
    semanticResult.planningRules?.blockedTimes ?? []
  ).filter((semantic) =>
    !localBlockedTimes.some((local) => {
      const semanticStart = new Date(semantic.start).getTime();
      const semanticEnd = new Date(semantic.end).getTime();
      const localStart = new Date(local.start).getTime();
      const localEnd = new Date(local.end).getTime();
      return (
        Number.isFinite(semanticStart) &&
        Number.isFinite(semanticEnd) &&
        Number.isFinite(localStart) &&
        Number.isFinite(localEnd) &&
        Math.abs(semanticStart - localStart) <= 60_000 &&
        Math.abs(semanticEnd - localEnd) <= 15 * 60_000
      );
    }),
  );
  const blockedTimes = [
    ...semanticBlockedTimes,
    ...localBlockedTimes,
  ].filter(
    (item, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.start === item.start && candidate.end === item.end,
      ) === index,
  );
  const planningRules = {
    ...semanticResult.planningRules,
    ...(blockedTimes.length ? { blockedTimes } : {}),
  };
  return Object.keys(planningRules).length ? planningRules : undefined;
}

/**
 * An explicit weekday agenda has already supplied placement, even when a row
 * describes task-like work rather than an appointment. The semantic provider
 * still owns titles and other meaning, while the deterministic pass owns the
 * row's date, start, bounded end, and protected-free-time blocks.
 */
export function applyExplicitDayAgendaScaffolding(
  input: ExtractionInput,
  semanticResult: ExtractionResult,
  localResult: ExtractionResult,
): ExtractionResult {
  if (!isExplicitDayAgenda(input.text)) return semanticResult;
  const rows = agendaRows(input);
  const scaffolds = mapLocalScaffolds(input, localResult, rows);
  if (!scaffolds.length) return semanticResult;

  const pairs = scaffolds
    .flatMap((scaffold, scaffoldIndex) =>
      semanticResult.tasks.map((semanticTask, taskIndex) => ({
        scaffoldIndex,
        taskIndex,
        score: rowMatchScore(input, semanticTask, scaffold.row),
      })),
    )
    .filter(({ score }) => score >= 65)
    .sort((left, right) => right.score - left.score);
  const semanticByScaffold = new Map<number, number>();
  const usedSemanticTasks = new Set<number>();
  pairs.forEach(({ scaffoldIndex, taskIndex }) => {
    if (
      semanticByScaffold.has(scaffoldIndex) ||
      usedSemanticTasks.has(taskIndex)
    ) {
      return;
    }
    semanticByScaffold.set(scaffoldIndex, taskIndex);
    usedSemanticTasks.add(taskIndex);
  });

  const tasks = scaffolds.map((scaffold, scaffoldIndex) => {
    const semanticTaskIndex = semanticByScaffold.get(scaffoldIndex);
    return applyScaffold(
      semanticTaskIndex === undefined
        ? scaffold.localTask
        : semanticResult.tasks[semanticTaskIndex],
      scaffold,
    );
  });
  const protectedRows = rows.filter((row) => row.protectedTime);
  semanticResult.tasks.forEach((semanticTask, taskIndex) => {
    if (usedSemanticTasks.has(taskIndex)) return;
    const duplicatesAgendaRow = scaffolds.some(
      ({ row }) => rowMatchScore(input, semanticTask, row) >= 65,
    );
    const representsProtectedTime = protectedRows.some(
      (row) => rowMatchScore(input, semanticTask, row) >= 65,
    );
    if (!duplicatesAgendaRow && !representsProtectedTime) tasks.push(semanticTask);
  });

  const ignoredStatements = [...semanticResult.ignoredStatements];
  protectedRows.forEach(({ span }) => {
    if (
      !ignoredStatements.some(
        (statement) => normalized(statement.sourceText) === normalized(span.quote),
      )
    ) {
      ignoredStatements.push({
        sourceText: span.quote,
        reason: "Protected free time added as a scheduling rule.",
      });
    }
  });

  return {
    ...semanticResult,
    tasks,
    ignoredStatements,
    planningRules: mergeBlockedTimes(semanticResult, localResult),
  };
}
