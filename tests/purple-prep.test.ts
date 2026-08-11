import { describe, expect, it } from "vitest";
import { MockTaskExtractionProvider } from "../lib/providers/mock-extraction";
import { recoverFlexibleRecurrences } from "../lib/providers/flexible-recurrence-recovery";
import { recoverExplicitOverdueTasks } from "../lib/providers/overdue-recovery";
import { recoverTimedRecurrences } from "../lib/providers/recurrence-recovery";

const PURPLE_PREP_CHECKLIST = `[Purple Prep Checklist](https://go.sa.northwestern.edu/newstudent/)
[ Checklist](https://go.sa.northwestern.edu/newstudent/student/checklist)
[ Resources](https://go.sa.northwestern.edu/newstudent/student/resources)
[Zach](https://go.sa.northwestern.edu/newstudent/student/checklist#) [Liu](https://go.sa.northwestern.edu/newstudent/student/checklist#)
**Total Progress**
**52%**
**29** **of** **55** **Completed**

[**2**](https://go.sa.northwestern.edu/newstudent/student/checklist#needs-attention-modal) [**Tasks Need Attention**](https://go.sa.northwestern.edu/newstudent/student/checklist#needs-attention-modal)
Due in May
Due in June
Due in July
Due in August
Due in September
**Tasks Due in** **August**
**Request that your final high school transcript is sent to Northwestern** 8/01/26
*This task will automatically check when completed*
**Review weeks 1-4 of Before the Arch content (optional)** 8/03/26
**Read your early-August Purple Prep email** 8/04/26
**Add parent/guardian authorized payer to your student account on CAESAR (optional)** 8/08/26
**Confirm or waive the student health insurance plan** 8/15/26
**Complete the process for classroom accommodation considerations** 8/15/26 **From Survey**
**Read your mid-August Purple Prep email** 8/18/26
**Select a move-in appointment (Mid-August)** 8/21/26
**Complete the Preparing for Academics at Northwestern Module** 8/31/26
**Reply to your Peer Adviser's introductory email** 8/31/26
**View an email from your McCormick first-year adviser regarding fall course options** 8/31/26 **MEAS**`;

describe("Purple Prep checklist import", () => {
  it("interprets the pasted portal text without treating navigation or progress as tasks", async () => {
    const input = {
      text: PURPLE_PREP_CHECKLIST,
      currentLocalDate: "2026-08-10",
      timeZone: "America/Los_Angeles",
    };
    const extracted = await new MockTaskExtractionProvider().extractTasks(input);
    const withOverdue = await recoverExplicitOverdueTasks(input, extracted);
    const withTimedRecurrences = await recoverTimedRecurrences(input, withOverdue);
    const result = await recoverFlexibleRecurrences(input, withTimedRecurrences);

    expect(extracted.tasks.map((task) => task.title)).toEqual([
      "Request that your final high school transcript is sent to Northwestern",
      "Review weeks 1-4 of Before the Arch content (optional)",
      "Read your early-August Purple Prep email",
      "Add parent/guardian authorized payer to your student account on CAESAR (optional)",
      "Confirm or waive the student health insurance plan",
      "Complete the process for classroom accommodation considerations From Survey",
      "Read your mid-August Purple Prep email",
      "Select a move-in appointment (Mid-August)",
      "Complete the Preparing for Academics at Northwestern Module",
      "Reply to your Peer Adviser's introductory email",
      "View an email from your McCormick first-year adviser regarding fall course options MEAS",
    ]);
    expect(withOverdue.tasks).toHaveLength(11);
    expect(withTimedRecurrences.tasks).toHaveLength(11);
    expect(result.tasks).toHaveLength(11);
    expect(result.tasks.map((task) => task.dueDate)).toEqual([
      "2026-08-01",
      "2026-08-03",
      "2026-08-04",
      "2026-08-08",
      "2026-08-15",
      "2026-08-15",
      "2026-08-18",
      "2026-08-21",
      "2026-08-31",
      "2026-08-31",
      "2026-08-31",
    ]);
    expect(result.tasks.every((task) => !/[\[\]*]/.test(task.title))).toBe(true);
    expect(
      result.tasks.find((task) => task.title.includes("move-in appointment")),
    ).toMatchObject({ taskType: "flexible", dueDate: "2026-08-21" });
    expect(
      result.ignoredStatements.some((item) => item.sourceText.includes("52%")),
    ).toBe(true);
  });
});
