import { readFileSync } from "node:fs";
import { formatInTimeZone } from "date-fns-tz";
import { afterEach, expect, it, vi } from "vitest";
import { GeminiTaskExtractionProvider } from "../lib/providers/gemini-extraction";
import { runExtractionPipeline } from "../lib/providers/extraction-pipeline";

vi.mock("server-only", () => ({}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("imports the captured 22-task checklist with deadlines without a repair request or local fallback", async () => {
  const source = readFileSync(new URL("./fixtures/purple-prep/source.txt", import.meta.url), "utf8").trimEnd();
  const raw = readFileSync(new URL("./fixtures/purple-prep/raw-gemini.json", import.meta.url), "utf8");
  const responsibilities = JSON.parse(raw).responsibilities as Array<{ title: string; deadline: { date: string; strength: string } }>;
  vi.stubEnv("GEMINI_API_KEY", "regression-test-key");
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    candidates: [{ finishReason: "STOP", content: { parts: [{ text: raw }] } }],
  })));
  vi.stubGlobal("fetch", fetchMock);

  const output = await runExtractionPipeline(
    { text: source, currentLocalDate: "2026-09-05", timeZone: "America/Los_Angeles" },
    { semanticProviderName: "gemini", semanticProvider: new GeminiTaskExtractionProvider(), allowLocalFallback: false },
  );

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(output.report).toMatchObject({ semanticProviderUsed: true, localFallbackUsed: false });
  expect(output.result.tasks).toHaveLength(22);
  for (const responsibility of responsibilities) {
    const task = output.result.tasks.find((item) => item.title === responsibility.title);
    expect(task).toBeDefined();
    expect(task?.deadlineStrength).toBe(responsibility.deadline.strength);
    if (responsibility.deadline.strength === "hard") {
      expect(task?.dueDate).toBe(responsibility.deadline.date);
    } else {
      expect(task?.schedulingConstraints?.preferredDateWindows?.some((window) =>
        formatInTimeZone(window.start, "America/Los_Angeles", "yyyy-MM-dd") === responsibility.deadline.date,
      )).toBe(true);
    }
    expect(task?.fixedStartAt).toBeUndefined();
    expect(task?.fixedEndAt).toBeUndefined();
  }
});
