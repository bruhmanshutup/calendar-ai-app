export const MAX_AI_IMPORT_WORDS = 500;

export function countImportWords(text: string): number {
  const normalized = text.trim();
  return normalized ? normalized.split(/\s+/u).length : 0;
}

export function importExceedsWordLimit(text: string): boolean {
  return countImportWords(text) > MAX_AI_IMPORT_WORDS;
}
