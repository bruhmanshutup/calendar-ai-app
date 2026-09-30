import { describe, expect, it } from "vitest";
import { documentFileError, documentMime, formatDocumentPages } from "../lib/domain/document-import";
import { extractionResultSchema } from "../lib/domain/extraction-schema";

describe("document import contracts", () => {
  it("recognizes supported file signatures rather than trusting extensions", () => {
    expect(documentMime(new TextEncoder().encode("%PDF-1.7\n"))).toBe("application/pdf");
    expect(documentMime(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))).toBe("image/png");
    expect(documentMime(new Uint8Array([255, 216, 255, 224]))).toBe("image/jpeg");
    expect(documentMime(new TextEncoder().encode("RIFFxxxxWEBP"))).toBe("image/webp");
    expect(documentMime(new TextEncoder().encode("not a document"))).toBeUndefined();
  });

  it("enforces the browser upload contract", () => {
    expect(documentFileError({ name: "notes.txt", size: 20 })).toMatch(/PDF|PNG|JPG/i);
    expect(documentFileError({ name: "syllabus.pdf", size: 0 })).toMatch(/empty/i);
    expect(documentFileError({ name: "syllabus.pdf", size: 6 * 1024 * 1024 })).toMatch(/5 MB/i);
    expect(documentFileError({ name: "syllabus.pdf", size: 20 })).toBeUndefined();
  });

  it("keeps page boundaries in the transcript sent to extraction", () => {
    expect(formatDocumentPages([
      { page: 1, text: "Due Friday" },
      { page: 2, text: "Room 210" },
    ])).toBe("[Page 1]\nDue Friday\n\n[Page 2]\nRoom 210");
  });

  it("allows app-owned source references while the model schema does not need to create them", () => {
    const result = extractionResultSchema.parse({
      tasks: [{
        title: "Submit assignment",
        taskType: "flexible",
        priority: "medium",
        category: "school",
        energyDemand: "medium",
        splittable: false,
        confidence: 0.9,
        fieldConfidence: { title: 0.9, taskType: 0.9 },
        missingInformation: [],
        sourceText: "[Page 1]\nSubmit assignment by Friday",
        sourceDocument: { id: "00000000-0000-4000-8000-000000000000", name: "syllabus.pdf", pages: [1] },
      }],
      ignoredStatements: [],
    });
    expect(result.tasks[0].sourceDocument?.pages).toEqual([1]);
  });
});
