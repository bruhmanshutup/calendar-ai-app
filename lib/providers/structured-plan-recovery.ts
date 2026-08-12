import { validateAndDedupeExtraction } from "@/lib/domain/extraction-schema";
import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
} from "@/lib/domain/types";

type StructuredPlanItem = {
  week: number;
  weekTitle: string;
  goal?: string;
  day: number;
  action: string;
  sourceText: string;
};

type StructuredPlan = {
  items: StructuredPlanItem[];
  weekCount: number;
  title?: string;
};

const WEEK_HEADING =
  /^\s*week\s+(\d{1,3})\s*(?:[\p{Pd}:]|-{1,2})\s*(.+?)\s*$/iu;
const GOAL_LINE = /^\s*goal\s*:\s*(.+?)\s*$/i;
const CHECKLIST_HEADING = /^\s*(?:daily|weekly)?\s*checklist\s*:\s*$/i;
const CHECKLIST_ITEM =
  /^\s*(?:[☐☑✓✔□]\s*|\[[ xX]\]\s*|[-*•]\s*)?day\s+(\d{1,3})\s*:\s*(.+?)\s*$/iu;

function cleanAction(value: string): string {
  return value.trim().replace(/[\s.]+$/, "");
}

function comparable(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

export function parseStructuredLearningPlan(
  text: string,
): StructuredPlan | undefined {
  const items: StructuredPlanItem[] = [];
  const weeks = new Set<number>();
  let currentWeek: number | undefined;
  let currentWeekTitle = "";
  let currentGoal: string | undefined;
  let inChecklist = false;
  let title: string | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const week = WEEK_HEADING.exec(line);
    if (week) {
      currentWeek = Number(week[1]);
      currentWeekTitle = week[2].trim();
      currentGoal = undefined;
      inChecklist = false;
      weeks.add(currentWeek);
      continue;
    }

    if (currentWeek === undefined && !title) title = line;

    if (currentWeek === undefined) continue;
    const goal = GOAL_LINE.exec(line);
    if (goal) {
      currentGoal = goal[1].trim();
      continue;
    }
    if (CHECKLIST_HEADING.test(line)) {
      inChecklist = true;
      continue;
    }
    if (!inChecklist) continue;

    const item = CHECKLIST_ITEM.exec(line);
    if (!item) continue;
    const action = cleanAction(item[2]);
    if (!action) continue;
    items.push({
      week: currentWeek,
      weekTitle: currentWeekTitle,
      goal: currentGoal,
      day: Number(item[1]),
      action,
      sourceText: rawLine.trim(),
    });
  }

  if (weeks.size < 2 || items.length < 4) return undefined;
  return { items, weekCount: weeks.size, title };
}

export function prepareStructuredPlanExtractionInput(
  input: ExtractionInput,
): ExtractionInput {
  const plan = parseStructuredLearningPlan(input.text);
  if (!plan) return input;

  const rows = plan.items.map(
    (item) =>
      `Week ${item.week} — ${item.weekTitle} | Day ${item.day}: ${item.action}`,
  );
  return {
    ...input,
    text: [
      `Structured ${plan.weekCount}-week learning plan with ${plan.items.length} checklist responsibilities.`,
      "Extract exactly one flexible task for every Week/Day row below.",
      "Week and Day numbers express sequence only; they are not dates, deadlines, recurrence counts, or fixed times.",
      "Do not create tasks from the plan title, week headings, goals, tutorial links, or checklist labels.",
      "Do not invent a plan start date or due dates.",
      ...rows,
    ].join("\n"),
  };
}

function fallbackEffort(action: string): {
  minutes: number;
  rationale: string;
} {
  const lower = action.toLocaleLowerCase();
  if (/\b(?:1\s*[–-]\s*2|two)\s+pages?\b|\breport\b/.test(lower)) {
    return {
      minutes: 90,
      rationale: "Allowed a focused block for drafting and revising the written deliverable.",
    };
  }
  if (
    /\b(?:install|build|edit|create|run|re-?run|simulate|simulation|case)\b/.test(
      lower,
    )
  ) {
    return {
      minutes: 60,
      rationale: "Allowed a practical work block for setup, execution, and checking results.",
    };
  }
  if (/\b(?:write|summarize|compare|calculate|calculations|chart|plots?|sketch|draw)\b/.test(lower)) {
    return {
      minutes: 45,
      rationale: "Allowed time to complete and check the short analysis or deliverable.",
    };
  }
  return {
    minutes: 30,
    rationale: "Used a short focused-learning estimate for the reading or review activity.",
  };
}

function matchingTask(
  tasks: ExtractedTask[],
  item: StructuredPlanItem,
  used: Set<number>,
): ExtractedTask | undefined {
  const action = comparable(item.action);
  const index = tasks.findIndex((task, taskIndex) => {
    if (used.has(taskIndex)) return false;
    const source = comparable(task.sourceText);
    const title = comparable(task.title);
    return source.includes(action) || title.includes(action);
  });
  if (index < 0) return undefined;
  used.add(index);
  return tasks[index];
}

function normalizedPlanTask(
  item: StructuredPlanItem,
  existing: ExtractedTask | undefined,
  sequenceGroupId: string,
  anchorDate: string,
): ExtractedTask {
  const fallback = fallbackEffort(item.action);
  const estimatedMinutes = existing?.estimatedMinutes ?? fallback.minutes;
  const sourceText = `Week ${item.week} — ${item.weekTitle}\n${item.sourceText}`;
  return {
    id: `structured-plan-w${String(item.week).padStart(3, "0")}-d${String(item.day).padStart(3, "0")}`,
    title: `Week ${item.week}, Day ${item.day}: ${item.action}`,
    description: [
      `Week ${item.week} — ${item.weekTitle}`,
      item.goal ? `Goal: ${item.goal}` : undefined,
    ]
      .filter(Boolean)
      .join(". "),
    taskType: "flexible",
    estimatedMinutes,
    effortEstimateSource: existing?.effortEstimateSource ?? "heuristic",
    effortEstimateRationale:
      existing?.effortEstimateRationale ?? fallback.rationale,
    priority: existing?.priority ?? "medium",
    category: "school",
    energyDemand: existing?.energyDemand ?? "medium",
    splittable: existing?.splittable ?? estimatedMinutes > 60,
    minimumSessionMinutes: Math.min(
      estimatedMinutes,
      existing?.minimumSessionMinutes ?? Math.min(30, estimatedMinutes),
    ),
    sequence: {
      groupId: sequenceGroupId,
      order: item.week * 1_000 + item.day,
      week: item.week,
      day: item.day,
      anchorDate,
      minimumGapDays: 1,
    },
    confidence: Math.max(existing?.confidence ?? 0, 0.9),
    fieldConfidence: {
      title: 0.99,
      taskType: 0.99,
      estimatedMinutes:
        existing?.fieldConfidence.estimatedMinutes ?? 0.68,
      priority: existing?.fieldConfidence.priority ?? 0.75,
    },
    missingInformation: [],
    sourceText,
    approved: true,
    reviewRequired: false,
  };
}

function stablePlanId(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function recoverStructuredLearningPlan(
  input: ExtractionInput,
  result: ExtractionResult,
): ExtractionResult {
  const plan = parseStructuredLearningPlan(input.text);
  if (!plan) return result;

  const used = new Set<number>();
  const sequenceGroupId = `structured-plan-${stablePlanId(
    comparable(input.text),
  )}`;
  const tasks = plan.items.map((item) =>
    normalizedPlanTask(
      item,
      matchingTask(result.tasks, item, used),
      sequenceGroupId,
      input.currentLocalDate,
    ),
  );
  const checklistSources = new Set(
    plan.items.map((item) => comparable(item.sourceText)),
  );

  return validateAndDedupeExtraction({
    tasks,
    planningRules: result.planningRules,
    ignoredStatements: result.ignoredStatements.filter(
      (statement) => !checklistSources.has(comparable(statement.sourceText)),
    ),
  });
}
