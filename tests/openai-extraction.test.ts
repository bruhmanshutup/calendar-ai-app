import { afterEach, describe, expect, it, vi } from "vitest";
import { task } from "./fixtures";

const fetchState = vi.hoisted(() => ({
  call: vi.fn(),
}));

vi.mock("server-only", () => ({}));

import { OpenAITaskExtractionProvider } from "../lib/providers/openai-extraction";

const input = {
  currentLocalDate: "2026-09-19",
  timeZone: "America/Chicago",
};

function responseFor(output: unknown) {
  return new Response(
    JSON.stringify({ output_text: JSON.stringify(output) }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function stubFetch() {
  vi.stubGlobal("fetch", fetchState.call);
  fetchState.call.mockReset();
  return fetchState.call;
}

describe("OpenAI selective verification", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns a valid draft before the route times out if verification stalls", async () => {
    vi.useFakeTimers();
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_EXTRACTION_VERIFY", "always");
    const draft = { tasks: [task({ title: "Read chapter", sourceText: "Read chapter" })], ignoredStatements: [] };
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValueOnce(responseFor(draft)).mockImplementationOnce((_url, options) => new Promise((_, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("timeout")));
    }));
    const provider = new OpenAITaskExtractionProvider();
    const result = provider.extractTasks({ ...input, text: "Read chapter" });
    await vi.advanceTimersByTimeAsync(40_000);
    expect((await result).tasks[0].title).toBe("Read chapter");
    expect(provider.getDiagnostics().verificationSucceeded).toBe(false);
    expect(provider.getDiagnostics().verificationReasons).toContain("verification-failed-kept-draft");
  });

  it("skips the verifier for a short explicit draft in auto mode", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_EXTRACTION_VERIFY", "auto");
    const fetchMock = stubFetch();
    fetchMock.mockResolvedValue(
      responseFor({
        tasks: [
          task({
            id: "meeting",
            title: "Attend the staff meeting",
            sourceText: "Tomorrow at 9 AM, attend the staff meeting.",
            taskType: "fixed_time",
            fixedStartAt: "2026-09-20T14:00:00.000Z",
            fixedEndAt: "2026-09-20T15:00:00.000Z",
          }),
        ],
        ignoredStatements: [],
        planningRules: null,
      }),
    );

    const provider = new OpenAITaskExtractionProvider();
    await provider.extractTasks({
      ...input,
      text: "Tomorrow at 9 AM, attend the staff meeting.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(provider.getDiagnostics()).toMatchObject({
      verificationMode: "auto",
      verificationAttempted: false,
      verificationSkipped: true,
      verificationSucceeded: false,
    });
  });

  it("uses the verifier for a relational draft in auto mode", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_EXTRACTION_VERIFY", "auto");
    const fetchMock = stubFetch();
    const draft = {
      tasks: [
        task({
          id: "draft",
          title: "Finish the draft",
          sourceText: "Finish the draft before the meeting.",
          confidence: 0.8,
          dependencies: [
            { relation: "before" as const, targetTitle: "Meeting" },
          ],
        }),
      ],
      ignoredStatements: [],
      planningRules: null,
    };
    fetchMock
      .mockResolvedValueOnce(responseFor(draft))
      .mockResolvedValueOnce(responseFor(draft));

    const provider = new OpenAITaskExtractionProvider();
    await provider.extractTasks({
      ...input,
      text: "Finish the draft before the meeting.",
      globalInstructions: "Only import the draft; use the meeting as context.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(JSON.parse(call[1].body).instructions).toContain("Only import the draft; use the meeting as context.");
    }
    expect(provider.getDiagnostics()).toMatchObject({
      verificationMode: "auto",
      verificationAttempted: true,
      verificationSkipped: false,
      verificationSucceeded: true,
    });
  });
});
