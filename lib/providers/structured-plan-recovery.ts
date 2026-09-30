import { validateAndDedupeExtraction } from "@/lib/domain/extraction-schema";
import { resolveRelativeDate } from "@/lib/domain/date-interpretation";
import { addDays, format, parseISO } from "date-fns";
import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
  FieldProvenance,
  SourceEvidenceSpan,
} from "@/lib/domain/types";

type StructuredPlanItem = {
  week: number;
  weekTitle: string;
  goal?: string;
  day: number;
  action: string;
  sourceText: string;
  sourceStart: number;
  sourceEnd: number;
  weekSourceText: string;
  weekSourceStart: number;
  weekSourceEnd: number;
  weekdayExpression?: string;
  weekdayStart?: number;
  weekdayEnd?: number;
};

type StructuredPlan = {
  items: StructuredPlanItem[];
  weekCount: number;
  title?: string;
};

type StructuredPlanAnchor = {
  date: string;
  evidence: SourceEvidenceSpan;
};

const WEEK_HEADING =
  /^\s*week\s+(\d{1,3})\s*(?:[\p{Pd}:]|-{1,2})\s*(.+?)\s*$/iu;
const GOAL_LINE = /^\s*goal\s*:\s*(.+?)\s*$/i;
const CHECKLIST_HEADING = /^\s*(?:daily|weekly)?\s*checklist\s*:\s*$/i;
const CHECKLIST_ITEM =
  /^\s*(?:[☐☑✓✔□]\s*|\[[ xX]\]\s*|[-*•]\s*)?(?:(?:day\s+(\d{1,3}))|((?:(?:this|next)\s+)?(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\.?))\s*:\s*(.+?)\s*$/iu;

const WEEKDAY_NAME: Record<string, string> = {
  mon: "monday",
  monday: "monday",
  tue: "tuesday",
  tuesday: "tuesday",
  wed: "wednesday",
  wednesday: "wednesday",
  thu: "thursday",
  thursday: "thursday",
  fri: "friday",
  friday: "friday",
  sat: "saturday",
  saturday: "saturday",
  sun: "sunday",
  sunday: "sunday",
};

function normalizedWeekdayExpression(expression: string): string | undefined {
  const normalized = expression
    .trim()
    .toLocaleLowerCase()
    .replace(/\.$/, "");
  const parts = /^(?:(this|next)\s+)?(.+)$/.exec(normalized);
  const weekday = parts?.[2] ? WEEKDAY_NAME[parts[2]] : undefined;
  return weekday ? [parts?.[1], weekday].filter(Boolean).join(" ") : undefined;
}

function weekdayDay(expression: string): number | undefined {
  const weekday = normalizedWeekdayExpression(expression)?.replace(
    /^(?:this|next)\s+/,
    "",
  );
  return weekday
    ? ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].indexOf(
        weekday,
      ) + 1
    : undefined;
}

function sourceLines(
  text: string,
): Array<{ text: string; start: number; end: number }> {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) break;
    const line = match[0].replace(/(?:\r\n|\r|\n)$/, "");
    const start = match.index;
    lines.push({ text: line, start, end: start + line.length });
  }
  return lines;
}

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
  let currentWeekSourceText = "";
  let currentWeekSourceStart = 0;
  let currentWeekSourceEnd = 0;
  let currentGoal: string | undefined;
  let inChecklist = false;
  let title: string | undefined;

  for (const sourceLine of sourceLines(text)) {
    const rawLine = sourceLine.text;
    const line = rawLine.trim();
    if (!line) continue;

    const week = WEEK_HEADING.exec(line);
    if (week) {
      currentWeek = Number(week[1]);
      currentWeekTitle = week[2].trim();
      currentWeekSourceText = rawLine;
      currentWeekSourceStart = sourceLine.start;
      currentWeekSourceEnd = sourceLine.end;
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
    const action = cleanAction(item[3]);
    if (!action) continue;
    const weekdayExpression = item[2]?.trim();
    const day = item[1]
      ? Number(item[1])
      : weekdayExpression
        ? weekdayDay(weekdayExpression)
        : undefined;
    if (!day) continue;
    const weekdayOffset = weekdayExpression
      ? rawLine.toLocaleLowerCase().indexOf(weekdayExpression.toLocaleLowerCase())
      : -1;
    items.push({
      week: currentWeek,
      weekTitle: currentWeekTitle,
      goal: currentGoal,
      day,
      action,
      sourceText: rawLine,
      sourceStart: sourceLine.start,
      sourceEnd: sourceLine.end,
      weekSourceText: currentWeekSourceText,
      weekSourceStart: currentWeekSourceStart,
      weekSourceEnd: currentWeekSourceEnd,
      weekdayExpression,
      weekdayStart:
        weekdayOffset >= 0 ? sourceLine.start + weekdayOffset : undefined,
      weekdayEnd:
        weekdayOffset >= 0
          ? sourceLine.start + weekdayOffset + weekdayExpression!.length
          : undefined,
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
      `[${item.sourceStart},${item.sourceEnd}) Week ${item.week} — ${item.weekTitle} | Day ${item.day}: ${item.action}`,
  );
  const structureHint = [
    input.structureHint,
    `Structured ${plan.weekCount}-week learning plan with ${plan.items.length} checklist responsibilities.`,
    "Discovery map only. The original source content remains authoritative.",
    "Discover exactly one responsibility for every indexed Week/Day row below and retain its exact [start,end) source span.",
    "Week and Day numbers express sequence only; they are not dates, deadlines, recurrence counts, or fixed times.",
    "An explicit plan start in the preamble anchors Week 1 / Day 1; preserve it as sequence.anchorDate while keeping untimed checklist actions flexible.",
    "Do not create tasks from the plan title, week headings, goals, tutorial links, or checklist labels.",
    "Do not invent a plan start date or due dates.",
    ...rows,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    ...input,
    text: input.text,
    structureHint,
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

function itemSourceSpan(
  item: StructuredPlanItem,
  sourceId?: string,
): SourceEvidenceSpan {
  return {
    sourceId,
    start: item.sourceStart,
    end: item.sourceEnd,
    quote: item.sourceText,
  };
}

function resolvePlanAnchor(
  plan: StructuredPlan,
  input: ExtractionInput,
): StructuredPlanAnchor | undefined {
  // A plan-wide start is the Week 1 / Day 1 anchor, even when it is not
  // Monday. Only inspect the preamble so dates in exercises or resources
  // cannot accidentally become the entire plan's start date.
  for (const line of sourceLines(input.text)) {
    if (WEEK_HEADING.test(line.text)) break;
    const declaration = /^\s*(?:the\s+)?plan\s+(?:starts?|begins?)(?:\s+on)?\s*:?\s+(.+?)\s*[.!]?\s*$/i.exec(line.text);
    if (!declaration) continue;
    const expression = declaration[1];
    const resolved = resolveRelativeDate(
      expression,
      input.currentLocalDate,
      input.timeZone,
    );
    if (!resolved.date || resolved.ambiguous) return undefined;
    const start = line.start + line.text.indexOf(expression);
    return {
      date: resolved.date,
      evidence: {
        sourceId: input.sourceId,
        start,
        end: start + expression.length,
        quote: expression,
      },
    };
  }
  const explicitStart = plan.items.find(
    (item) => item.week === 1 && item.weekdayExpression,
  );
  if (
    !explicitStart?.weekdayExpression ||
    explicitStart.weekdayStart === undefined ||
    explicitStart.weekdayEnd === undefined
  ) {
    return undefined;
  }
  const resolved = resolveRelativeDate(
    normalizedWeekdayExpression(explicitStart.weekdayExpression) ??
      explicitStart.weekdayExpression,
    input.currentLocalDate,
    input.timeZone,
  );
  if (!resolved.date || resolved.ambiguous) return undefined;

  return {
    // sequence.anchorDate is Week 1 / Day 1. A later weekday label therefore
    // points back to the first day of that same plan week.
    date: format(
      addDays(parseISO(resolved.date), -(explicitStart.day - 1)),
      "yyyy-MM-dd",
    ),
    evidence: {
      sourceId: input.sourceId,
      start: explicitStart.weekdayStart,
      end: explicitStart.weekdayEnd,
      quote: input.text.slice(
        explicitStart.weekdayStart,
        explicitStart.weekdayEnd,
      ),
    },
  };
}

function normalizedPlanTask(
  item: StructuredPlanItem,
  existing: ExtractedTask | undefined,
  sequenceGroupId: string,
  anchor: StructuredPlanAnchor | undefined,
  sourceId?: string,
): ExtractedTask {
  const fallback = fallbackEffort(item.action);
  const estimatedMinutes = existing?.estimatedMinutes ?? fallback.minutes;
  const sourceText = `Week ${item.week} — ${item.weekTitle}\n${item.sourceText}`;
  const sourceSpan = itemSourceSpan(item, sourceId);
  const weekSourceSpan: SourceEvidenceSpan = {
    sourceId,
    start: item.weekSourceStart,
    end: item.weekSourceEnd,
    quote: item.weekSourceText,
  };
  const inferredEstimate = existing?.effortEstimateSource !== "stated";
  const fieldProvenance: FieldProvenance[] = [
    {
      path: "title",
      origin: "explicit",
      evidence: [sourceSpan],
    },
    {
      path: "taskType",
      origin: "derived",
      evidence: [sourceSpan],
      rationale: "A checklist action is represented as one flexible responsibility.",
    },
    {
      path: "sequence.week",
      origin: "explicit",
      evidence: [weekSourceSpan],
    },
    {
      path: "sequence.day",
      origin: item.weekdayExpression ? "derived" : "explicit",
      evidence: [sourceSpan],
      rationale: item.weekdayExpression
        ? "Converted the checklist weekday label to its Monday-through-Sunday day number."
        : undefined,
    },
    {
      path: "sequence.order",
      origin: "derived",
      evidence: [sourceSpan],
      rationale: "Derived deterministically from the explicit Week and Day labels.",
    },
    {
      path: "sequence.minimumGapDays",
      origin: "derived",
      evidence: [sourceSpan],
      rationale: "Successive daily checklist items are kept on successive days.",
    },
    ...(anchor
      ? [
          {
            path: "sequence.anchorDate",
            origin: "derived" as const,
            evidence: [anchor.evidence],
            rationale:
              "Resolved the explicit plan start or Week 1 weekday relative to the user's local date.",
          },
        ]
      : []),
    {
      path: "estimatedMinutes",
      origin: inferredEstimate ? "inferred" : "explicit",
      evidence: inferredEstimate ? undefined : [sourceSpan],
      rationale: inferredEstimate
        ? existing?.effortEstimateRationale ?? fallback.rationale
        : "The source or extractor identified an explicit duration.",
    },
    {
      path: "priority",
      origin: "inferred",
      rationale: "No explicit priority was stated for this checklist row.",
    },
    {
      path: "category",
      origin: "inferred",
      rationale: "Classified from the learning-plan context.",
    },
    {
      path: "energyDemand",
      origin: "inferred",
      rationale: "Estimated from the kind of learning activity.",
    },
  ];
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
      ...(anchor ? { anchorDate: anchor.date } : {}),
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
    missingInformation: anchor ? [] : ["Choose a plan start date"],
    sourceText,
    sourceSpan,
    fieldProvenance,
    approved: Boolean(anchor),
    reviewRequired: !anchor,
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
  const anchor = resolvePlanAnchor(plan, input);
  const tasks = plan.items.map((item) =>
    normalizedPlanTask(
      item,
      matchingTask(result.tasks, item, used),
      sequenceGroupId,
      anchor,
      input.sourceId,
    ),
  );
  const checklistSources = new Set(
    plan.items.map((item) => comparable(item.sourceText)),
  );

  return validateAndDedupeExtraction({
    ...result,
    tasks,
    ignoredStatements: result.ignoredStatements.filter(
      (statement) => !checklistSources.has(comparable(statement.sourceText)),
    ),
  });
}
