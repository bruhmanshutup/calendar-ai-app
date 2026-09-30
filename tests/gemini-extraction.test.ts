import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiTaskExtractionProvider,
  resolveGeminiGenerationSettings,
} from "../lib/providers/gemini-extraction";
import { prepareTaskExtractionInput } from "../lib/providers/narrative-structure";

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

  it("uses Gemini defaults unless generation overrides are configured", () => {
    expect(resolveGeminiGenerationSettings({})).toEqual({});
    expect(
      resolveGeminiGenerationSettings({
        GEMINI_TEMPERATURE: "0.6",
        GEMINI_THINKING_LEVEL: "medium",
      }),
    ).toEqual({ temperature: 0.6, thinkingLevel: "medium" });
  });

  it("rejects invalid Gemini generation overrides", () => {
    expect(() =>
      resolveGeminiGenerationSettings({ GEMINI_TEMPERATURE: "cold" }),
    ).toThrow("GEMINI_TEMPERATURE");
    expect(() =>
      resolveGeminiGenerationSettings({ GEMINI_THINKING_LEVEL: "maximum" }),
    ).toThrow("GEMINI_THINKING_LEVEL");
  });

  it("requests structured estimates and validates the response", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-secret");
    vi.stubEnv("GEMINI_MODEL", "gemini-test-model");
    const source =
      "I need to draft the Zephyr outline by Friday. It should take about 75 minutes.";
    const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                      responsibilities: [
                        {
                          id: "gemini-task",
                          title: "Draft project outline",
                          kind: "task",
                          sourceText: source,
                          deadline: {
                            date: "2026-07-31",
                            strength: "hard",
                            confidence: 0.95,
                          },
                          duration: {
                            minimumMinutes: 75,
                            preferredMinutes: 75,
                            maximumMinutes: 75,
                            explicit: true,
                          },
                          planning: {
                            estimatedMinutes: 75,
                            minimumSessionMinutes: 30,
                            category: "school",
                            energyDemand: "high",
                            priority: "high",
                            splittable: true,
                          },
                          confidence: 0.95,
                          missingInformation: [],
                          reviewRequired: false,
                        },
                      ],
                      relations: [],
                      blockedTimes: [],
                      globalInstructions: [],
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
      text: source,
    });
    const result = await new GeminiTaskExtractionProvider().extractTasks(
      narrativeInput,
    );

    expect(result.tasks[0]).toMatchObject({
      estimatedMinutes: 75,
      minimumSessionMinutes: 30,
      effortEstimateSource: "stated",
    });
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("gemini-test-model:generateContent");
    expect(new Headers(options.headers).get("x-goog-api-key")).toBe(
      "test-secret",
    );
    const body = JSON.parse(String(options.body)) as {
      generationConfig: {
        responseMimeType: string;
        temperature?: number;
      };
      contents: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.temperature).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.contents[0].parts[0].text).toContain("estimatedMinutes");
    expect(body.contents[0].parts[0].text).toContain("Stable ids");
    expect(body.contents[0].parts[0].text).toContain("allowedWindows");
    expect(body.contents[0].parts[0].text).toContain("blockedTimes");
    expect(body.contents[0].parts[0].text).not.toContain(
      "Immutable discovery",
    );
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

  it("accepts harmless optional nulls and mechanical clock formatting without a repair call", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-secret");
    const source =
      "The actual submission isn’t until next Wednesday at midnight.";
    const semanticDraft = {
      responsibilities: [
        {
          id: "lab-report",
          title: "Finish lab report",
          kind: "TASK",
          sourceText: source,
          sourceStart: null,
          sourceEnd: null,
          factEvidence: null,
          deadline: {
            date: " 2026-09-09 ",
            time: "midnight",
            period: null,
            strength: "HARD",
            confidence: 0.97,
          },
          occurrence: null,
          duration: null,
          constraints: null,
          recurrence: null,
          conditionalRules: null,
          planning: {
            estimatedMinutes: 90,
            priority: "MEDIUM",
            category: "SCHOOL",
            energyDemand: "HIGH",
            splittable: true,
            minimumSessionMinutes: 30,
          },
          confidence: 0.96,
          missingInformation: [],
          reviewRequired: false,
        },
      ],
      relations: [],
      blockedTimes: [],
      globalInstructions: [],
      ignoredStatements: [],
    };
    const response = (value: unknown) =>
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: JSON.stringify(value) }] } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const fetchMock = vi.fn().mockResolvedValueOnce(response(semanticDraft));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GeminiTaskExtractionProvider().extractTasks({
      ...input,
      currentLocalDate: "2026-08-31",
      text: source,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.tasks[0]).toMatchObject({
      id: "lab-report",
      dueDate: "2026-09-09",
      dueTime: "23:59",
      deadlineStrength: "hard",
      priority: "medium",
      category: "school",
      energyDemand: "high",
    });
  });

  it("does not misreport a failed repair request as invalid semantic JSON", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-secret");
    const source = "Finish the lab report by Wednesday.";
    const invalidDraft = {
      responsibilities: [
        {
          id: "lab-report",
          title: "Finish lab report",
          kind: "task",
          sourceText: source,
          confidence: null,
          missingInformation: [],
          reviewRequired: false,
        },
      ],
      relations: [],
      blockedTimes: [],
      globalInstructions: [],
      ignoredStatements: [],
    };
    const structuredResponse = (value: unknown) =>
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: JSON.stringify(value) }] } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(structuredResponse(invalidDraft))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "request rejected" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GeminiTaskExtractionProvider().extractTasks({
        ...input,
        text: source,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("identifies a response cut off by Gemini's output-token limit", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-secret");
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "MAX_TOKENS",
              content: { parts: [{ text: '{"responsibilities":[' }] },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new GeminiTaskExtractionProvider().extractTasks(input),
    ).rejects.toMatchObject({
      code: "INVALID_PROVIDER_OUTPUT",
      fallbackReason: "output_token_limit",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("repairs malformed JSON once before falling back", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-secret");
    const source = "Finish the lab report by Wednesday.";
    const validDraft = {
      responsibilities: [
        {
          id: "lab-report",
          title: "Finish lab report",
          kind: "task",
          sourceText: source,
          deadline: {
            date: "2026-09-09",
            strength: "hard",
            confidence: 0.95,
          },
          confidence: 0.95,
          missingInformation: [],
          reviewRequired: false,
        },
      ],
      relations: [],
      blockedTimes: [],
      globalInstructions: [],
      ignoredStatements: [],
    };
    const responseText = (text: string) =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text }] } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responseText('{"responsibilities":['))
      .mockResolvedValueOnce(responseText(JSON.stringify(validDraft)));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GeminiTaskExtractionProvider().extractTasks({
      ...input,
      text: source,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.tasks[0]).toMatchObject({
      title: "Finish lab report",
      dueDate: "2026-08-05",
    });
  });

  it("recovers a missing occurrence date from an explicit relative date", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-secret");
    const source = "Meet the day after tomorrow around lunch.";
    const draft = {
      responsibilities: [
        {
          id: "meeting",
          title: "Meet",
          kind: "event",
          sourceText: source,
          occurrence: { period: "around lunch", confidence: 0.9 },
          confidence: 0.9,
          missingInformation: ["Confirm the exact meeting time."],
          reviewRequired: true,
        },
      ],
      relations: [],
      blockedTimes: [],
      globalInstructions: [],
      ignoredStatements: [],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: JSON.stringify(draft) }] } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GeminiTaskExtractionProvider().extractTasks({
      ...input,
      text: source,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.tasks[0].occurrenceWindow).toMatchObject({
      start: "2026-08-01T07:00:00.000Z",
      label: "around lunch",
    });
  });

  it("compiles provider-local dates and clocks into zoned instants", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-secret");
    const source = "Submit the design proposal Friday at 11:59 PM.";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                      responsibilities: [
                        {
                          id: "deadline",
                          title: "Submit design proposal",
                          kind: "task",
                          sourceText: source,
                          deadline: {
                            date: "2026-09-04",
                            time: "23:59",
                            strength: "hard",
                            confidence: 0.98,
                          },
                          confidence: 0.98,
                          missingInformation: [],
                          reviewRequired: false,
                        },
                      ],
                      relations: [],
                      blockedTimes: [],
                      globalInstructions: [],
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

    const result = await new GeminiTaskExtractionProvider().extractTasks({
      ...input,
      currentLocalDate: "2026-09-02",
      text: source,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.tasks[0]).toMatchObject({
      dueDate: "2026-09-04",
      dueTime: "23:59",
      dueAt: "2026-09-05T06:59:00.000Z",
    });
  });

  it("keeps an explicit prerequisite from the one-pass interpretation", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-secret");
    const source =
      "Order the motor once the shaft diameter is finalized. Shipping takes four days.";
    const orderText = source.slice(0, source.indexOf(".") + 1);
    const prerequisiteText = "once the shaft diameter is finalized";
    const semanticDraft = {
      responsibilities: [
        {
          id: "order-motor",
          title: "Order motor",
          kind: "task",
          sourceText: orderText,
          confidence: 0.96,
          missingInformation: [],
          reviewRequired: false,
        },
        {
          id: "prerequisite-shaft-diameter",
          title: "Finalize shaft diameter",
          kind: "task",
          sourceText: prerequisiteText,
          confidence: 0.96,
          missingInformation: [],
          reviewRequired: false,
        },
      ],
      relations: [
        {
          fromId: "prerequisite-shaft-diameter",
          toId: "order-motor",
          relation: "before",
          strength: "hard",
          reason: "The motor can only be ordered after shaft diameter is finalized.",
          sourceText: orderText,
        },
      ],
      blockedTimes: [],
      globalInstructions: [],
      ignoredStatements: [],
    };
    const response = (value: unknown) =>
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: JSON.stringify(value) }] } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const fetchMock = vi.fn().mockResolvedValueOnce(response(semanticDraft));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new GeminiTaskExtractionProvider().extractTasks({
      ...input,
      text: source,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const semanticRequest = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    ) as { contents: Array<{ parts: Array<{ text: string }> }> };
    expect(semanticRequest.contents[0].parts[0].text).toContain(
      source,
    );
    expect(semanticRequest.contents[0].parts[0].text).not.toContain(
      "Immutable discovery",
    );
    expect(result.tasks.map((task) => task.title)).toEqual([
      "Order motor",
      "Finalize shaft diameter",
    ]);
    expect(
      result.tasks.find((task) => task.id === "prerequisite-shaft-diameter")
        ?.dependencies,
    ).toEqual([
      expect.objectContaining({
        taskId: "order-motor",
        relation: "before",
        strength: "hard",
      }),
    ]);
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
