import { validateAndDedupeExtraction } from "@/lib/domain/extraction-schema";
import type {
  ExtractedTask,
  ExtractionInput,
  ExtractionResult,
} from "@/lib/domain/types";
import { MockTaskExtractionProvider } from "./mock-extraction";

const OVERDUE_STATUS = /\(\s*overdue\s*\)|\boverdue\b/i;

function normalizedSource(value: string): string {
  return value
    .replace(OVERDUE_STATUS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function normalizedTitle(value: string): string {
  return value
    .replace(OVERDUE_STATUS, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function alreadyExtracted(
  tasks: ExtractedTask[],
  candidate: ExtractedTask,
): boolean {
  const source = normalizedSource(candidate.sourceText);
  const title = normalizedTitle(candidate.title);
  return tasks.some(
    (task) =>
      normalizedSource(task.sourceText) === source ||
      (task.dueDate === candidate.dueDate && normalizedTitle(task.title) === title),
  );
}

export async function recoverExplicitOverdueTasks(
  input: ExtractionInput,
  result: ExtractionResult,
): Promise<ExtractionResult> {
  const overdueLines = input.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => OVERDUE_STATUS.test(line));

  if (overdueLines.length === 0) return result;

  const local = await new MockTaskExtractionProvider().extractTasks({
    ...input,
    text: overdueLines.join("\n"),
  });
  const recovered = local.tasks
    .filter((candidate) => !alreadyExtracted(result.tasks, candidate))
    .map((candidate, index) => ({
      ...candidate,
      id: `recovered-overdue-${index + 1}`,
      priority: "urgent" as const,
    }));

  if (recovered.length === 0) return result;

  const recoveredSources = new Set(
    recovered.map((task) => normalizedSource(task.sourceText)),
  );
  return validateAndDedupeExtraction({
    tasks: [...result.tasks, ...recovered],
    planningRules: result.planningRules,
    ignoredStatements: result.ignoredStatements.filter(
      (statement) => !recoveredSources.has(normalizedSource(statement.sourceText)),
    ),
  });
}
