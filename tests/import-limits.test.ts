import { describe, expect, it } from "vitest";
import {
  countImportWords,
  importExceedsWordLimit,
  MAX_AI_IMPORT_WORDS,
} from "../lib/domain/import-limits";

describe("AI import word limit", () => {
  it("counts whitespace-delimited words without counting blank input", () => {
    expect(countImportWords("  Exercise every day.\nExcept Friday.  ")).toBe(5);
    expect(countImportWords(" \n\t ")).toBe(0);
  });

  it("accepts the tested ceiling and rejects the next word", () => {
    expect(importExceedsWordLimit("task ".repeat(MAX_AI_IMPORT_WORDS))).toBe(false);
    expect(importExceedsWordLimit("task ".repeat(MAX_AI_IMPORT_WORDS + 1))).toBe(true);
  });
});
