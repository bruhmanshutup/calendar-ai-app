import { addDays, format, parseISO } from "date-fns";
import type { ExtractedTask } from "./types";

export type TaskSequenceDescriptor = {
  groupId: string;
  order: number;
  week?: number;
  day?: number;
  anchorDate?: string;
  minimumGapDays: number;
};

const TITLE_SEQUENCE = /^\s*week\s+(\d{1,3})\s*[,\-–—]?\s*day\s+(\d{1,3})\s*:/i;
const ID_SEQUENCE = /^structured-plan-(?:([a-z0-9]+)-)?w(\d{1,3})-d(\d{1,3})(?:-|$)/i;

export function taskSequence(
  task: ExtractedTask,
): TaskSequenceDescriptor | undefined {
  if (task.sequence) {
    return {
      ...task.sequence,
      minimumGapDays: task.sequence.minimumGapDays ?? 1,
    };
  }

  const idMatch = task.id ? ID_SEQUENCE.exec(task.id) : undefined;
  const titleMatch = TITLE_SEQUENCE.exec(task.title);
  const week = Number(idMatch?.[2] ?? titleMatch?.[1]);
  const day = Number(idMatch?.[3] ?? titleMatch?.[2]);
  if (!Number.isInteger(week) || !Number.isInteger(day)) return undefined;

  return {
    groupId: idMatch?.[1]
      ? `structured-plan-${idMatch[1].toLocaleLowerCase()}`
      : "structured-plan-legacy",
    order: week * 1_000 + day,
    week,
    day,
    minimumGapDays: 1,
  };
}

export function sequenceTargetDate(
  sequence: TaskSequenceDescriptor,
  fallbackAnchorDate: string,
): string {
  const anchorDate = sequence.anchorDate ?? fallbackAnchorDate;
  const offset =
    sequence.week && sequence.day
      ? (sequence.week - 1) * 7 + (sequence.day - 1)
      : Math.max(0, sequence.order);
  return format(addDays(parseISO(anchorDate), offset), "yyyy-MM-dd");
}

export function latestSequenceTargetDate(
  tasks: ExtractedTask[],
  fallbackAnchorDate: string,
): string | undefined {
  return tasks.reduce<string | undefined>((latest, task) => {
    const sequence = taskSequence(task);
    if (!sequence) return latest;
    const target = sequenceTargetDate(sequence, fallbackAnchorDate);
    return !latest || target > latest ? target : latest;
  }, undefined);
}
