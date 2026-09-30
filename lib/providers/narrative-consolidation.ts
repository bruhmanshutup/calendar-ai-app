import { validateAndDedupeExtraction } from "@/lib/domain/extraction-schema";
import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
  TaskPriority,
} from "@/lib/domain/types";
import {
  analyzeNarrativeStructure,
  type NarrativeStructureRole,
  type NarrativeStructureSegment,
} from "./narrative-structure";

type NarrativeGroup = {
  id: string;
  role: NarrativeStructureRole;
  segments: NarrativeStructureSegment[];
  sourceText: string;
};

type MappedTask = {
  task: ExtractedTask;
  group?: NarrativeGroup;
  sourceRole?: "primary" | "detail" | "global";
};

const GROUP_START_ROLES = new Set<NarrativeStructureRole>([
  "action",
  "dependent_action",
  "possible_multiple_actions",
  "list_item",
  "email_subject",
  "global_schedule_rule",
]);
const DETAIL_ROLES = new Set<NarrativeStructureRole>([
  "detail",
  "heading_or_context",
]);
const STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "am",
  "an",
  "and",
  "around",
  "at",
  "be",
  "before",
  "but",
  "by",
  "do",
  "for",
  "from",
  "go",
  "have",
  "hour",
  "hours",
  "i",
  "in",
  "into",
  "is",
  "it",
  "like",
  "me",
  "minute",
  "minutes",
  "my",
  "need",
  "of",
  "on",
  "or",
  "please",
  "probably",
  "should",
  "sometime",
  "that",
  "the",
  "then",
  "this",
  "time",
  "times",
  "to",
  "total",
  "want",
  "week",
  "weekly",
  "will",
  "with",
  "would",
]);

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLocaleLowerCase();
}

function stem(token: string): string {
  const aliases: Record<string, string> = {
    gym: "workout",
    groceries: "grocery",
    grocery: "grocery",
    workout: "workout",
    workouts: "workout",
  };
  if (aliases[token]) return aliases[token];
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("ing")) {
    const base = token.slice(0, -3);
    return /(.)\1$/.test(base) ? base.slice(0, -1) : base;
  }
  if (token.length > 4 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function tokens(value: string): Set<string> {
  return new Set(
    normalized(value)
      .split(" ")
      .filter((token) => token && !STOP_WORDS.has(token) && !/^\d+$/.test(token))
      .map(stem),
  );
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  left.forEach((token) => {
    if (right.has(token)) shared += 1;
  });
  return shared / Math.min(left.size, right.size);
}

function joinSegments(segments: NarrativeStructureSegment[]): string {
  return segments.reduce((text, segment, index) => {
    if (index === 0) return segment.text.trim();
    const previous = segments[index - 1];
    const separator = previous.line === segment.line ? " " : "\n";
    return `${text}${separator}${segment.text.trim()}`;
  }, "");
}

function narrativeGroups(text: string): NarrativeGroup[] {
  const groups: NarrativeGroup[] = [];
  let current: NarrativeGroup | undefined;
  analyzeNarrativeStructure(text).forEach((segment) => {
    if (GROUP_START_ROLES.has(segment.role)) {
      current = {
        id: `p${segment.paragraph}-l${segment.line}-s${segment.sentence}`,
        role: segment.role,
        segments: [segment],
        sourceText: segment.text.trim(),
      };
      groups.push(current);
      return;
    }
    if (
      current &&
      current.segments[0].paragraph === segment.paragraph &&
      DETAIL_ROLES.has(segment.role)
    ) {
      current.segments.push(segment);
      current.sourceText = joinSegments(current.segments);
    }
  });
  return groups;
}

function sourceRole(task: ExtractedTask, group: NarrativeGroup): MappedTask["sourceRole"] {
  const source = normalized(task.sourceText);
  const matching = group.segments.filter((segment) => {
    const text = normalized(segment.text);
    return text.length >= 8 && (source.includes(text) || text.includes(source));
  });
  if (!matching.length) return undefined;
  if (matching.every((segment) => segment.role === "global_schedule_rule")) {
    return "global";
  }
  if (matching.every((segment) => DETAIL_ROLES.has(segment.role))) {
    return "detail";
  }
  return "primary";
}

function mapTask(task: ExtractedTask, groups: NarrativeGroup[]): MappedTask {
  const source = normalized(task.sourceText);
  const titleTokens = tokens(task.title);
  let best:
    | { group: NarrativeGroup; score: number; role?: MappedTask["sourceRole"] }
    | undefined;
  groups.forEach((group) => {
    const groupSource = normalized(group.sourceText);
    const actionText = group.segments[0]?.text ?? group.sourceText;
    const contained =
      source.length >= 8 &&
      (groupSource.includes(source) || source.includes(groupSource));
    const titleOverlap = overlap(titleTokens, tokens(actionText));
    if (!contained && titleOverlap < 0.5) return;
    const role = sourceRole(task, group);
    const score = (contained ? 3 : 0) + titleOverlap + (role === "primary" ? 0.5 : 0);
    if (!best || score > best.score) best = { group, score, role };
  });
  return best
    ? { task, group: best.group, sourceRole: best.role }
    : { task };
}

function priorityRank(priority: TaskPriority): number {
  return { low: 0, medium: 1, high: 2, urgent: 3 }[priority];
}

function taskQuality(task: ExtractedTask): number {
  const vagueTitle = /^(?:i|we|this|that|it|need|break|also|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
    task.title.trim(),
  );
  return (
    (task.reviewRequired ? 0 : 30) +
    (task.approved ? 12 : 0) +
    task.confidence * 10 +
    (task.effortEstimateSource === "stated"
      ? 8
      : task.effortEstimateSource === "ai"
        ? 5
        : 0) +
    (task.schedulingConstraints ? 5 : 0) +
    (task.recurrence ? 5 : 0) +
    (task.fixedStartAt ? 5 : 0) +
    (vagueTitle ? -8 : 4) -
    task.missingInformation.length * 2
  );
}

function mergeDescriptions(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  if (normalized(left).includes(normalized(right))) return left;
  if (normalized(right).includes(normalized(left))) return right;
  return left.length >= right.length ? left : right;
}

function mergeTasks(
  left: ExtractedTask,
  right: ExtractedTask,
  sourceText: string,
): ExtractedTask {
  const preferred = taskQuality(left) >= taskQuality(right) ? left : right;
  const other = preferred === left ? right : left;
  const priority =
    priorityRank(preferred.priority) >= priorityRank(other.priority)
      ? preferred.priority
      : other.priority;
  const schedulingConstraints =
    preferred.schedulingConstraints || other.schedulingConstraints
      ? {
          ...other.schedulingConstraints,
          ...preferred.schedulingConstraints,
          allowedTimeWindows:
            preferred.schedulingConstraints?.allowedTimeWindows ??
            other.schedulingConstraints?.allowedTimeWindows,
          preferredTimeWindows:
            preferred.schedulingConstraints?.preferredTimeWindows ??
            other.schedulingConstraints?.preferredTimeWindows,
          preferredDateWindows:
            preferred.schedulingConstraints?.preferredDateWindows ??
            other.schedulingConstraints?.preferredDateWindows,
        }
      : undefined;
  return {
    ...preferred,
    description: mergeDescriptions(preferred.description, other.description),
    dueDate: preferred.dueDate ?? other.dueDate,
    dueTime: preferred.dueTime ?? other.dueTime,
    dueAt: preferred.dueAt ?? other.dueAt,
    dueWindow: preferred.dueWindow ?? other.dueWindow,
    fixedStartAt: preferred.fixedStartAt ?? other.fixedStartAt,
    fixedEndAt: preferred.fixedEndAt ?? other.fixedEndAt,
    estimatedMinutes: preferred.estimatedMinutes ?? other.estimatedMinutes,
    effortEstimateSource:
      preferred.effortEstimateSource ?? other.effortEstimateSource,
    effortEstimateRationale:
      preferred.effortEstimateRationale ?? other.effortEstimateRationale,
    minimumSessionMinutes:
      preferred.minimumSessionMinutes ?? other.minimumSessionMinutes,
    schedulingConstraints,
    sequence: preferred.sequence ?? other.sequence,
    recurrence: preferred.recurrence ?? other.recurrence,
    priority,
    confidence: Math.max(preferred.confidence, other.confidence),
    fieldConfidence: {
      ...other.fieldConfidence,
      ...preferred.fieldConfidence,
    },
    sourceText,
  };
}

function likelyDuplicate(
  left: ExtractedTask,
  right: ExtractedTask,
  group: NarrativeGroup,
): boolean {
  if (left.taskType !== right.taskType) return false;
  const titleOverlap = overlap(tokens(left.title), tokens(right.title));
  if (titleOverlap >= 0.72) return true;
  return group.role !== "possible_multiple_actions" && titleOverlap >= 0.45;
}

/**
 * Removes fragment tasks produced from continuation sentences, joins the full
 * relevant source span back onto surviving tasks, and merges model/local
 * duplicates without collapsing distinct task types or multi-action prose.
 */
export function consolidateNarrativeExtraction(
  input: ExtractionInput,
  result: ExtractionResult,
): ExtractionResult {
  if (result.tasks.length > 0 && result.tasks.every((task) => task.sequence)) {
    return result;
  }
  const groups = narrativeGroups(input.text);
  if (!groups.length || !result.tasks.length) return result;
  const mapped = result.tasks.map((task) => mapTask(task, groups));
  const removed: MappedTask[] = [];

  const kept = mapped.filter((candidate) => {
    if (candidate.group?.role === "global_schedule_rule") {
      removed.push(candidate);
      return false;
    }
    if (candidate.sourceRole !== "detail" || !candidate.group) return true;
    const hasPrimary = mapped.some(
      (other) =>
        other !== candidate &&
        other.group?.id === candidate.group?.id &&
        other.sourceRole !== "detail" &&
        other.group?.role !== "global_schedule_rule",
    );
    if (hasPrimary) removed.push(candidate);
    return !hasPrimary;
  });

  const consolidated: MappedTask[] = [];
  kept.forEach((candidate) => {
    const group = candidate.group;
    if (!group) {
      consolidated.push(candidate);
      return;
    }
    const duplicateIndex = consolidated.findIndex(
      (other) =>
        other.group?.id === group.id &&
        likelyDuplicate(other.task, candidate.task, group),
    );
    if (duplicateIndex < 0) {
      consolidated.push({
        ...candidate,
        task: { ...candidate.task, sourceText: group.sourceText },
      });
      return;
    }
    const existing = consolidated[duplicateIndex];
    consolidated[duplicateIndex] = {
      ...existing,
      task: mergeTasks(existing.task, candidate.task, group.sourceText),
    };
    removed.push(candidate);
  });

  for (let index = consolidated.length - 1; index >= 0; index -= 1) {
    const candidate = consolidated[index];
    if (candidate.group?.role !== "email_subject") continue;
    const bodyIndex = consolidated.findIndex(
      (other, otherIndex) =>
        otherIndex !== index &&
        other.group?.role !== "email_subject" &&
        other.group?.segments[0].paragraph ===
          candidate.group?.segments[0].paragraph &&
        other.task.taskType === candidate.task.taskType &&
        overlap(tokens(other.task.title), tokens(candidate.task.title)) >= 0.72,
    );
    if (bodyIndex < 0) continue;
    const body = consolidated[bodyIndex];
    consolidated[bodyIndex] = {
      ...body,
      task: mergeTasks(
        body.task,
        candidate.task,
        body.group?.sourceText ?? body.task.sourceText,
      ),
    };
    removed.push(candidate);
    consolidated.splice(index, 1);
  }

  const ignoredStatements = [...result.ignoredStatements];
  removed.forEach(({ task, group, sourceRole: role }) => {
    if (ignoredStatements.length >= 100) return;
    if (
      ignoredStatements.some(
        (statement) => normalized(statement.sourceText) === normalized(task.sourceText),
      )
    ) {
      return;
    }
    ignoredStatements.push({
      sourceText: task.sourceText,
      reason:
        group?.role === "global_schedule_rule" || role === "global"
          ? "Global availability instruction; applied as a schedule rule instead of a task."
          : "Continuation or duplicate detail was merged into its responsibility.",
    });
  });

  return validateAndDedupeExtraction({
    ...result,
    tasks: consolidated.map(({ task }) => task).slice(0, 100),
    ignoredStatements,
  });
}
