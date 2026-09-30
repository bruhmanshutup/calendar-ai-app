import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { readDocument } from "../lib/providers/document-reader";

const bytes = new TextEncoder().encode("%PDF-1.7\n");
const transcript = { pages: [{ page: 1, text: "Submit report October 6 at 11:59 PM" }], warnings: [] };
const reply = (data: unknown = transcript, status = "completed") => new Response(JSON.stringify({
  status, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(data) }] }],
}));

describe("document transcription", () => {
  beforeEach(() => vi.stubEnv("OPENAI_API_KEY", "test-key"));
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

  it.each(["application/pdf", "image/png", "image/jpeg", "image/webp"])("transcribes %s using native Responses payloads", async (mime) => {
    const fetchMock = vi.fn().mockResolvedValue(reply());
    vi.stubGlobal("fetch", fetchMock);
    expect(await readDocument(bytes, mime)).toEqual(transcript);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    const attachment = payload.input[0].content[1];
    expect(attachment.type).toBe(mime === "application/pdf" ? "input_file" : "input_image");
    expect(attachment.file_data ?? attachment.image_url).toContain(`data:${mime};base64,`);
  });

  it.each([
    { pages: [{ page: 2, text: "Due Friday" }], warnings: [] },
    { pages: [{ page: 1, text: " " }], warnings: [] },
    { pages: Array.from({ length: 11 }, (_, i) => ({ page: i + 1, text: "Task" })), warnings: [] },
  ])("rejects empty or inconsistent page output", async (data) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(data)));
    await expect(readDocument(bytes, "application/pdf")).rejects.toThrow();
  });

  it("rejects truncated output even when the JSON looks complete", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(transcript, "incomplete")));
    await expect(readDocument(bytes, "application/pdf")).rejects.toThrow(/completely/);
  });

  it("does not send an already cancelled request", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    await expect(readDocument(bytes, "image/png", AbortSignal.abort())).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps its timeout active while consuming a stalled response body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => ({
      ok: true,
      json: () => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))),
    })));
    const reading = readDocument(bytes, "image/png");
    const assertion = expect(reading).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates caller cancellation after response headers", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => ({
      ok: true,
      json: () => new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("cancelled")));
        controller.abort();
      }),
    })));
    await expect(readDocument(bytes, "image/png", controller.signal)).rejects.toThrow("cancelled");
  });
});
