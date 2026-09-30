import { describe, expect, it } from "vitest";
import { mergeImportedPlanningRules } from "../lib/domain/planning-rules";

describe("imported planning rules", () => {
  it("replaces the prior week's copy of the same protected-time rule", () => {
    const result = mergeImportedPlanningRules(
      {
        blockedTimes: [
          {
            start: "2026-08-20T03:00:00.000Z",
            end: "2026-08-20T07:00:00.000Z",
            label: "Protected free time",
          },
        ],
      },
      {
        blockedTimes: [
          {
            start: "2026-08-27T03:00:00.000Z",
            end: "2026-08-27T07:00:00.000Z",
            label: "Protected free time",
          },
        ],
      },
      "America/Los_Angeles",
    );

    expect(result.blockedTimes).toEqual([
      {
        start: "2026-08-27T03:00:00.000Z",
        end: "2026-08-27T07:00:00.000Z",
        label: "Protected free time",
      },
    ]);
  });

  it("keeps unrelated protected periods additive", () => {
    const friday = {
      start: "2026-08-22T03:00:00.000Z",
      end: "2026-08-22T07:00:00.000Z",
      label: "Protected free time",
    };
    const wednesday = {
      start: "2026-08-27T03:00:00.000Z",
      end: "2026-08-27T07:00:00.000Z",
      label: "Protected free time",
    };

    expect(
      mergeImportedPlanningRules(
        { blockedTimes: [friday] },
        { blockedTimes: [wednesday] },
        "America/Los_Angeles",
      ).blockedTimes,
    ).toEqual([friday, wednesday]);
  });
});
