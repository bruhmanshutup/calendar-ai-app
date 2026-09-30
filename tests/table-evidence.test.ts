import { describe, expect, it } from "vitest";
import { markdownScheduleEvidence } from "../lib/providers/table-evidence";

describe("Markdown schedule evidence", () => {
  it("labels time, activity, and location columns without mutating source", () => {
    const source = `| Time | What to do | Location |\n| --- | --- | --- |\n| 10:30–10:50 AM | Arrive and get ready | West Fairchild |`;
    expect(markdownScheduleEvidence(source)).toContain(
      "time: 10:30–10:50 AM; activity: Arrive and get ready; location: West Fairchild",
    );
  });

  it("returns nothing for ordinary prose", () => {
    expect(markdownScheduleEvidence("Meet me at 5 PM.")).toBeUndefined();
  });

  it("preserves headerless timetable rows and their date headings", () => {
    const source = `**Wednesday September 23**

| **12:00PM - 12:50PM** | **ISEN 220-0 Lecture** | **Harris Hall 107** | Instructor: Yip-Wah Chung |
| :-------------------- | :--------------------- | :------------------ | :------------------------- |
| **1:00PM - 1:50PM** | **MATH 220-2 Lecture** | **Room 2107** | Enrolled |`;

    expect(markdownScheduleEvidence(source)).toContain(
      "heading: Wednesday September 23; time: 12:00PM - 12:50PM; cells: [12:00PM - 12:50PM | ISEN 220-0 Lecture | Harris Hall 107 | Instructor: Yip-Wah Chung]",
    );
    expect(markdownScheduleEvidence(source)).toContain(
      "heading: Wednesday September 23; time: 1:00PM - 1:50PM; cells: [1:00PM - 1:50PM | MATH 220-2 Lecture | Room 2107 | Enrolled]",
    );
  });
});
