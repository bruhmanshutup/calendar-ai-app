import type { ExtractedTask } from "./types";

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const DOCUMENT_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp";
export type DocumentReference = { id: string; name: string; pages: number[] };
export type DocumentTranscript = {
  pages: Array<{ page: number; text: string }>;
  warnings: string[];
};

export function documentFileError(file: { name: string; size: number }): string | undefined {
  if (!/\.(pdf|png|jpe?g|webp)$/i.test(file.name)) return "Choose a PDF, PNG, JPG, or WebP file.";
  if (!file.size) return "This file is empty.";
  if (file.size > MAX_DOCUMENT_BYTES) return "Choose a file smaller than 5 MB.";
}

export function documentMime(bytes: Uint8Array): string | undefined {
  const prefix = new TextDecoder().decode(bytes.slice(0, 12));
  if (prefix.startsWith("%PDF-")) return "application/pdf";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") return "image/webp";
}

export function formatDocumentPages(pages: DocumentTranscript["pages"]): string {
  return pages.map(({ page, text }) => `[Page ${page}]\n${text}`).join("\n\n");
}

/** The reference is app-owned. The model cannot mint document IDs or approvals. */
export function attachDocumentSource(task: ExtractedTask, source: DocumentReference): ExtractedTask {
  return {
    ...task,
    sourceDocument: source,
    approved: false,
    reviewRequired: true,
    missingInformation: [
      ...task.missingInformation.slice(0, 19),
      "Compare dates and times with the original document before approving.",
    ],
  };
}
