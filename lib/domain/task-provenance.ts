import type {
  ExtractedTask,
  FieldOrigin,
  FieldProvenance,
} from "./types";

export function taskFieldProvenance(
  task: ExtractedTask,
  path: string,
): FieldProvenance | undefined {
  return task.fieldProvenance?.find((field) => field.path === path);
}

export function taskFieldOrigin(
  task: ExtractedTask,
  path: string,
): FieldOrigin | undefined {
  return taskFieldProvenance(task, path)?.origin;
}

export function withUserFieldProvenance(
  task: ExtractedTask,
  paths: string[],
): ExtractedTask["fieldProvenance"] {
  if (paths.length === 0) return task.fieldProvenance;
  const edited = new Set(paths);
  return [
    ...(task.fieldProvenance ?? []).filter((field) => !edited.has(field.path)),
    ...[...edited].map((path) => ({
      path,
      origin: "user" as const,
      rationale: "Edited after interpretation.",
    })),
  ];
}
