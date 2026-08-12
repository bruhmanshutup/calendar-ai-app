import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiTaskExtractionProvider } from "../lib/providers/gemini-extraction";
import { prepareTaskExtractionInput } from "../lib/providers/narrative-structure";
import { task } from "./fixtures";

vi.mock("server-only", () => ({}));

const input = {
  currentLocalDate: "2026-07-30",
  timeZone: "America/Los_Angeles",
  text: "Draft project outline by Friday",
};

describe("Gemini extraction provider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("requires a server-side API key", () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(() => new GeminiTaskExtractionProvider()).toThrow(
      "Gemini extraction is not configured",
    );
  });

  it("requests structured estimates and validates the response", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-secret");
    vi.stubEnv("GEMINI_MODEL", "gemini-test-model");
    const extracted = task({
      id: "gemini-task",
      title: "Draft project outline",
      estimatedMinutes: 75,
      minimumSessionMinutes: 30,
      effortEstimateSource: "ai",
      effortEstimateRationale:
        "A focused outline with a few sections typically needs about an hour.",
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      tasks: [extracted],
                      ignoredStatements: [],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const narrativeInput = prepareTaskExtractionInput({
      ...input,
      text:
        "I need to draft the Zephyr outline by Friday. It should take about 75 minutes.",
    });
    const result = await new GeminiTaskExtractionProvider().extractTasks(
      narrativeInput,
    );

    expect(result.tasks[0]).toMatchObject({
      estimatedMinutes: 75,
      minimumSessionMinutes: 30,
      effortEstimateSource: "ai",
    });
    const [url, options] = fetchMock.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toContain("gemini-test-model:generateContent");
    expect(new Headers(options.headers).get("x-goog-api-key")).toBe(
      "test-secret",
    );
    const body = JSON.parse(String(options.body)) as {
      generationConfig: {
        responseMimeType: string;
      };
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.contents[0].parts[0].text).toContain("estimatedMinutes");
    expect(body.contents[0].parts[0].text).toContain(
      "use the newest unquoted message as the primary source",
    );
    expect(body.contents[0].parts[0].text).toContain(
      "schedulingConstraints.allowedTimeWindows",
    );
    expect(body.contents[0].parts[0].text).toContain("planningRules");
    expect(body.contents[0].parts[0].text).toContain(
      "P = blank-line paragraph (strong boundary)",
    );
    expect(body.contents[0].parts[0].text).toContain(
      "P1: L1.S1=action; L1.S2=detail",
    );
    expect(
      body.contents[0].parts[0].text.match(
        /I need to draft the Zephyr outline by Friday\./g,
      ),
    ).toHaveLength(1);
  });

  it.runIf(process.env.GEMINI_LIVE_TEST === "1")(
    "extracts and estimates a real responsibility",
    async () => {
      const result = await new GeminiTaskExtractionProvider().extractTasks({
        ...input,
        text: "Prepare the quarterly project report by August 15, 2026.",
      });
      expect(result.tasks[0]).toMatchObject({
        dueDate: "2026-08-15",
        effortEstimateSource: "ai",
      });
      expect(result.tasks[0].estimatedMinutes).toBeGreaterThan(0);
      expect(result.tasks[0].minimumSessionMinutes).toBeGreaterThan(0);
    },
    30_000,
  );
});
