import { addDays, format, isMatch, isValid, parseISO } from "date-fns";
import { resolveRelativeDate } from "./date-interpretation";
import { taskSequence, type TaskSequenceDescriptor } from "./task-sequence";
import type { ExtractedTask } from "./types";

export type PlanAdjustmentOperation =
  | "set_start"
  | "shift_later"
  | "shift_earlier";

export type PlanAdjustmentErrorCode =
  | "unsupported_command"
  | "invalid_date"
  | "plan_not_found"
  | "ambiguous_plan"
  | "missing_task_id"
  | "missing_current_anchor"
  | "inconsistent_current_anchor";

export type PlanAdjustmentError = {
  code: PlanAdjustmentErrorCode;
  message: string;
};

export type PlanAdjustmentInput = {
  command: string;
  tasks: ExtractedTask[];
  currentLocalDate: string;
  timeZone: string;
  /** Restricts selection to the sequence group represented by these tasks. */
  recentTaskIds?: string[];
};

export type PlanAdjustmentPreview = {
  ok: boolean;
  operation: PlanAdjustmentOperation | null;
  operationLabel: string | null;
  groupId: string | null;
  oldAnchor: string | null;
  newAnchor: string | null;
  affectedTaskCount: number;
  affectedTaskIds: string[];
  adjustedTasks: ExtractedTask[];
  errors: PlanAdjustmentError[];
};

type AdjustmentIntent =
  | {
      operation: "set_start";
      dateExpression: string;
    }
  | {
      operation: "shift_later" | "shift_earlier";
      dayCount: number;
    };

type SequenceCandidate = {
  task: ExtractedTask;
  taskIndex: number;
  sequence: TaskSequenceDescriptor;
};

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  "twenty-one": 21,
  "twenty-two": 22,
  "twenty-three": 23,
  "twenty-four": 24,
  "twenty-five": 25,
  "twenty-six": 26,
  "twenty-seven": 27,
  "twenty-eight": 28,
  "twenty-nine": 29,
  thirty: 30,
  "thirty-one": 31,
};

const LATER_WORDS = new Set(["down", "later", "forward"]);
const EARLIER_WORDS = new Set(["back", "backward", "earlier"]);

function errorPreview(
  input: PlanAdjustmentInput,
  errors: PlanAdjustmentError[],
  partial: Partial<PlanAdjustmentPreview> = {},
): PlanAdjustmentPreview {
  return {
    ok: false,
    operation: null,
    operationLabel: null,
    groupId: null,
    oldAnchor: null,
    newAnchor: null,
    affectedTaskCount: 0,
    affectedTaskIds: [],
    adjustedTasks: [...input.tasks],
    errors,
    ...partial,
  };
}

function positiveDayCount(value: string): number | undefined {
  const normalized = value.trim().toLocaleLowerCase().replace(/\s+/g, "-");
  if (/^\d+$/.test(normalized)) {
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return NUMBER_WORDS[normalized];
}

function directionFor(value: string | undefined): "later" | "earlier" | undefined {
  if (!value) return undefined;
  if (LATER_WORDS.has(value)) return "later";
  if (EARLIER_WORDS.has(value)) return "earlier";
  return undefined;
}

function parseAdjustmentIntent(command: string): AdjustmentIntent | undefined {
  const normalized = command
    .trim()
    .replace(/[.!?]+$/, "")
    .replace(/^please\s+/i, "")
    .replace(/\s+/g, " ");

  const setStartPatterns = [
    /^start\s+(?:(?:this|the)\s+)?plan\s+(?:on\s+|at\s+|to\s+)?(.+)$/i,
    /^set\s+(?:(?:this|the)\s+)?plan(?:'s)?\s+start(?:\s+date)?\s+(?:to|on)\s+(.+)$/i,
  ];
  for (const pattern of setStartPatterns) {
    const match = pattern.exec(normalized);
    if (match?.[1]?.trim()) {
      return { operation: "set_start", dateExpression: match[1].trim() };
    }
  }

  const shift = /^(?:shift|move)\s+(?:(?:this|the)\s+)?plan\s+(?:(down|later|forward|back|backward|earlier)\s+)?(?:by\s+)?(.+?)\s+days?\s*(down|later|forward|back|backward|earlier)?$/i.exec(
    normalized,
  );
  if (!shift) return undefined;

  const before = directionFor(shift[1]?.toLocaleLowerCase());
  const after = directionFor(shift[3]?.toLocaleLowerCase());
  if (!before && !after || before && after && before !== after) return undefined;
  const dayCount = positiveDayCount(shift[2]);
  if (!dayCount) return undefined;
  return {
    operation: (before ?? after) === "later" ? "shift_later" : "shift_earlier",
    dayCount,
  };
}

function isCalendarDate(value: string): boolean {
  if (!isMatch(value, "yyyy-MM-dd")) return false;
  const parsed = parseISO(value);
  return isValid(parsed) && format(parsed, "yyyy-MM-dd") === value;
}

function sequenceGroups(tasks: ExtractedTask[]): Map<string, SequenceCandidate[]> {
  const groups = new Map<string, SequenceCandidate[]>();
  tasks.forEach((task, taskIndex) => {
    const sequence = taskSequence(task);
    if (!sequence) return;
    const current = groups.get(sequence.groupId) ?? [];
    current.push({ task, taskIndex, sequence });
    groups.set(sequence.groupId, current);
  });
  return groups;
}

function selectedGroupIds(
  groups: Map<string, SequenceCandidate[]>,
  recentTaskIds: string[] | undefined,
): string[] {
  if (!recentTaskIds?.length) return [...groups.keys()];
  const recent = new Set(recentTaskIds);
  return [...groups.entries()]
    .filter(([, candidates]) =>
      candidates.some((candidate) =>
        candidate.task.id ? recent.has(candidate.task.id) : false,
      ),
    )
    .map(([groupId]) => groupId);
}

function operationLabel(
  operation: PlanAdjustmentOperation,
  newAnchor: string,
  dayCount?: number,
): string {
  if (operation === "set_start") return `Set plan start to ${newAnchor}`;
  const direction = operation === "shift_later" ? "later" : "earlier";
  const count = dayCount ?? 1;
  return `Shift plan ${direction} by ${count} ${count === 1 ? "day" : "days"}`;
}

/**
 * Builds a deterministic, non-mutating preview for moving one structured task
 * sequence. Applying the preview is an explicit caller decision: use
 * `adjustedTasks` only after the user confirms it.
 */
export function previewPlanAdjustment(
  input: PlanAdjustmentInput,
): PlanAdjustmentPreview {
  const intent = parseAdjustmentIntent(input.command);
  if (!intent) {
    return errorPreview(input, [
      {
        code: "unsupported_command",
        message: "Use a plan start date or ask to shift the plan by a number of days.",
      },
    ]);
  }

  const groups = sequenceGroups(input.tasks);
  const candidateGroupIds = selectedGroupIds(groups, input.recentTaskIds);
  if (candidateGroupIds.length === 0) {
    return errorPreview(
      input,
      [{ code: "plan_not_found", message: "No structured plan matched this request." }],
      { operation: intent.operation },
    );
  }
  if (candidateGroupIds.length > 1) {
    return errorPreview(
      input,
      [
        {
          code: "ambiguous_plan",
          message: "More than one structured plan matched; select tasks from one plan first.",
        },
      ],
      { operation: intent.operation },
    );
  }

  const groupId = candidateGroupIds[0];
  const candidates = groups.get(groupId) ?? [];
  const missingId = candidates.some(({ task }) => !task.id);
  if (missingId) {
    return errorPreview(
      input,
      [
        {
          code: "missing_task_id",
          message: "Every task in the selected plan needs an ID before it can be adjusted.",
        },
      ],
      { operation: intent.operation, groupId },
    );
  }

  const anchors = [
    ...new Set(
      candidates
        .map(({ sequence }) => sequence.anchorDate)
        .filter((anchor): anchor is string => Boolean(anchor)),
    ),
  ];
  if (anchors.some((anchor) => !isCalendarDate(anchor)) || anchors.length > 1) {
    return errorPreview(
      input,
      [
        {
          code: "inconsistent_current_anchor",
          message: "The selected plan has conflicting or invalid start dates.",
        },
      ],
      { operation: intent.operation, groupId },
    );
  }
  const oldAnchor = anchors[0] ?? null;

  let newAnchor: string | undefined;
  let dayCount: number | undefined;
  if (intent.operation === "set_start") {
    const resolved = resolveRelativeDate(
      intent.dateExpression,
      input.currentLocalDate,
      input.timeZone,
    );
    if (!resolved.date || resolved.ambiguous || !isCalendarDate(resolved.date)) {
      return errorPreview(
        input,
        [
          {
            code: "invalid_date",
            message: resolved.explanation ?? "The requested plan start date is ambiguous.",
          },
        ],
        { operation: intent.operation, groupId, oldAnchor },
      );
    }
    newAnchor = resolved.date;
  } else {
    if (!oldAnchor) {
      return errorPreview(
        input,
        [
          {
            code: "missing_current_anchor",
            message: "Set a start date before shifting this plan.",
          },
        ],
        { operation: intent.operation, groupId },
      );
    }
    dayCount = intent.dayCount;
    const signedDays = intent.operation === "shift_later" ? dayCount : -dayCount;
    newAnchor = format(addDays(parseISO(oldAnchor), signedDays), "yyyy-MM-dd");
  }

  const affectedTaskIds = candidates.map(({ task }) => task.id as string);
  const affectedIndexes = new Set(candidates.map(({ taskIndex }) => taskIndex));
  const adjustedTasks = input.tasks.map((task, taskIndex) => {
    if (!affectedIndexes.has(taskIndex)) return task;
    const sequence = taskSequence(task) as TaskSequenceDescriptor;
    return {
      ...task,
      sequence: {
        ...(task.sequence ?? sequence),
        anchorDate: newAnchor,
      },
    };
  });

  return {
    ok: true,
    operation: intent.operation,
    operationLabel: operationLabel(intent.operation, newAnchor, dayCount),
    groupId,
    oldAnchor,
    newAnchor,
    affectedTaskCount: candidates.length,
    affectedTaskIds,
    adjustedTasks,
    errors: [],
  };
}
