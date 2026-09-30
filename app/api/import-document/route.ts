import { NextResponse } from "next/server";
import { MAX_DOCUMENT_BYTES, documentFileError, documentMime } from "@/lib/domain/document-import";
import { readDocument } from "@/lib/providers/document-reader";

const error = (message: string, status: number) => NextResponse.json({ error: { message } }, { status });

export async function POST(request: Request): Promise<Response> {
  // Bound the actual streamed body, not just a caller-supplied Content-Length.
  const limit = MAX_DOCUMENT_BYTES + 64 * 1024;
  if (Number(request.headers.get("content-length")) > limit) return error("Choose a file smaller than 5 MB.", 413);
  if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) return error("Upload a file using the document form.", 400);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();
  if (!reader) return error("Choose a document to read.", 400);
  let file: File;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > limit) {
        await reader.cancel();
        return error("Choose a file smaller than 5 MB.", 413);
      }
      chunks.push(chunk.value);
    }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
    const form = await new Response(combined, { headers: { "content-type": request.headers.get("content-type")! } }).formData();
    const files = form.getAll("file");
    if (files.length !== 1 || typeof files[0] === "string") return error("Choose one document at a time.", 400);
    file = files[0];
  } catch {
    return error("The file upload could not be read. Please choose it again.", 400);
  } finally {
    reader.releaseLock();
  }
  const invalid = documentFileError(file);
  if (invalid) return error(invalid, file.size > MAX_DOCUMENT_BYTES ? 413 : 400);
  const content = new Uint8Array(await file.arrayBuffer());
  const mime = documentMime(content);
  if (!mime) return error("The file contents are not a supported PDF or image.", 415);
  try {
    return NextResponse.json(await readDocument(content, mime, request.signal), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return error("Document reading failed. Try a clearer image or a PDF with fewer pages, or paste the text instead. Check that the server has an OpenAI key and a model supporting images and PDFs.", 503);
  }
}
