import { describe, expect, it, vi } from "vitest";

import { normalizeProviderExtractionOutput } from "../lib/providers/provider-output-normalization";
import { extractWithRepair } from "../lib/providers/validated-extraction";
import { task } from "./fixtures";

const input = { timeZone: "America/Los_Angeles" };

describe("provider output normalization", () => {
  it("normalizes an offset-less exact deadline without changing its local date", () => {
    const result = normalizeProviderExtractionOutput(
      {
        tasks: [
          {
            dueDate: "2026-09-04",
            dueTime: "23:59",
            dueAt: "2026-09-04T23:59:00",
          },
        ],
      },
      input,
    ) as { tasks: Array<{ dueDate: string; dueTime: string; dueAt: string }> };

    expect(result.tasks[0]).toEqual({
      dueDate: "2026-09-04",
      dueTime: "23:59",
      dueAt: "2026-09-05T06:59:00.000Z",
    });
  });

  it("normalizes fixed event instants", () => {
    const result = normalizeProviderExtractionOutput(
      {
        tasks: [
          {
            fixedStartAt: "2026-09-03T14:00",
            fixedEndAt: "2026-09-03 15:00:00",
          },
        ],
      },
      input,
    ) as {
      tasks: Array<{ fixedStartAt: string; fixedEndAt: string }>;
    };

    expect(result.tasks[0]).toEqual({
      fixedStartAt: "2026-09-03T21:00:00.000Z",
      fixedEndAt: "2026-09-03T22:00:00.000Z",
    });
  });

  it("normalizes deadline and preferred date windows recursively", () => {
    const result = normalizeProviderExtractionOutput(
      {
        tasks: [
          {
            dueWindow: {
              start: "2026-09-02T12:00:00",
              end: "2026-09-02T17:00:00",
              label: "Wednesday afternoon",
              precision: "named_period",
            },
            occurrenceWindow: {
              start: "2026-09-03T12:00:00",
              end: "2026-09-03T17:00:00",
              label: "Thursday afternoon",
              precision: "named_period",
            },
            schedulingConstraints: {
              allowedDateWindows: [
                {
                  start: "2026-09-05T11:00:00",
                  end: "2026-09-05T20:00:00",
                  label: "Saturday store hours",
                  precision: "exact",
                },
              ],
              preferredDateWindows: [
                {
                  start: "2026-09-03T17:00:00",
                  end: "2026-09-03T21:00:00",
                  label: "Thursday evening",
                  precision: "named_period",
                },
              ],
            },
          },
        ],
      },
      input,
    ) as {
      tasks: Array<{
        dueWindow: { start: string; end: string };
        occurrenceWindow: { start: string; end: string };
        schedulingConstraints: {
          allowedDateWindows: Array<{ start: string; end: string }>;
          preferredDateWindows: Array<{ start: string; end: string }>;
        };
      }>;
    };

    expect(result.tasks[0].dueWindow).toMatchObject({
      start: "2026-09-02T19:00:00.000Z",
      end: "2026-09-03T00:00:00.000Z",
    });
    expect(result.tasks[0].occurrenceWindow).toMatchObject({
      start: "2026-09-03T19:00:00.000Z",
      end: "2026-09-04T00:00:00.000Z",
    });
    expect(
      result.tasks[0].schedulingConstraints.allowedDateWindows[0],
    ).toMatchObject({
      start: "2026-09-05T18:00:00.000Z",
      end: "2026-09-06T03:00:00.000Z",
    });
    expect(
      result.tasks[0].schedulingConstraints.preferredDateWindows[0],
    ).toMatchObject({
      start: "2026-09-04T00:00:00.000Z",
      end: "2026-09-04T04:00:00.000Z",
    });
  });

  it("normalizes recurrence bounds and global blocked intervals", () => {
    const result = normalizeProviderExtractionOutput(
      {
        tasks: [
          {
            recurrence: {
              windowStart: "2026-09-07T00:00:00",
              windowEnd: "2026-12-11T23:59:00",
            },
          },
        ],
        planningRules: {
          blockedTimes: [
            {
              start: "2026-09-03T18:00:00",
              end: "2026-09-03T18:45:00",
              label: "Dinner",
            },
          ],
        },
      },
      input,
    ) as {
      tasks: Array<{ recurrence: { windowStart: string; windowEnd: string } }>;
      planningRules: {
        blockedTimes: Array<{ start: string; end: string }>;
      };
    };

    expect(result.tasks[0].recurrence).toEqual({
      windowStart: "2026-09-07T07:00:00.000Z",
      windowEnd: "2026-12-12T07:59:00.000Z",
    });
    expect(result.planningRules.blockedTimes[0]).toMatchObject({
      start: "2026-09-04T01:00:00.000Z",
      end: "2026-09-04T01:45:00.000Z",
    });
  });

  it("removes null object properties recursively without dropping array items", () => {
    const result = normalizeProviderExtractionOutput(
      {
        tasks: [
          {
            title: "Submit report",
            description: null,
            dueAt: null,
            dueWindow: null,
            schedulingConstraints: {
              preferredDateWindows: null,
            },
          },
          null,
        ],
        planningRules: null,
      },
      input,
    );

    expect(result).toEqual({
      tasks: [
        {
          title: "Submit report",
          schedulingConstraints: {},
        },
        null,
      ],
    });
  });

  it("leaves offset-aware instants and invalid local calendar times unchanged", () => {
    const result = normalizeProviderExtractionOutput(
      {
        tasks: [
          {
            dueAt: "2026-09-04T23:59:00-07:00",
            fixedStartAt: "2026-03-08T02:30:00",
          },
        ],
      },
      input,
    ) as { tasks: Array<{ dueAt: string; fixedStartAt: string }> };

    expect(result.tasks[0]).toEqual({
      dueAt: "2026-09-04T23:59:00-07:00",
      fixedStartAt: "2026-03-08T02:30:00",
    });
  });

  it("normalizes before validation so a mechanical repair avoids a second request", async () => {
    const request = vi.fn().mockResolvedValue({
      tasks: [
        {
          ...task({
            id: "meeting",
            title: "Feedback meeting",
            taskType: "fixed_time",
            dueDate: undefined,
            dueTime: undefined,
            dueAt: undefined,
            fixedStartAt: "2026-09-03T14:00:00",
            fixedEndAt: "2026-09-03T15:00:00",
          }),
          description: null,
        },
      ],
      ignoredStatements: [],
    });

    const result = await extractWithRepair(request, (value) =>
      normalizeProviderExtractionOutput(value, input),
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(result.tasks[0]).toMatchObject({
      fixedStartAt: "2026-09-03T21:00:00.000Z",
      fixedEndAt: "2026-09-03T22:00:00.000Z",
    });
    expect(result.tasks[0]).not.toHaveProperty("description");
  });
});
