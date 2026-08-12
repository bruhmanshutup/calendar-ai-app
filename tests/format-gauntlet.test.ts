import { describe, expect, it } from "vitest";
import { MockTaskExtractionProvider } from "../lib/providers/mock-extraction";

const base = {
  currentLocalDate: "2026-08-12",
  timeZone: "America/Los_Angeles",
};

async function extract(text: string) {
  return new MockTaskExtractionProvider().extractTasks({ ...base, text });
}

describe("responsibility format gauntlet", () => {
  it("extracts requests from a normal email without treating headers or signatures as tasks", async () => {
    const result = await extract(`From: Maya Chen <maya@example.com>
To: Zach Liu <zach@example.com>
Sent: Wednesday, August 12, 2026 8:12 AM
Subject: Orientation follow-up

Hi Zach,
Please submit the lab waiver by Aug 15.
Could you also call the program office Friday?

Thanks,
Maya`);

    expect(result.tasks.map((task) => task.title)).toEqual([
      "submit the lab waiver",
      "also call the program office",
    ]);
    expect(result.tasks.map((task) => task.dueDate)).toEqual([
      "2026-08-15",
      "2026-08-14",
    ]);
  });

  it("uses an actionable email subject when the body contains no duplicate request", async () => {
    const result = await extract(`From: registrar@example.edu
Subject: Action required: sign the housing waiver by August 18

Details are available in the student portal.
Regards,
Registrar`);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      title: "sign the housing waiver",
      dueDate: "2026-08-18",
    });
  });

  it("ignores quoted email history and extracts only the current request", async () => {
    const result = await extract(`Please upload the corrected form by tomorrow.

On Tue, Aug 11, 2026 at 4:02 PM Maya wrote:
> Please submit the old form by Wednesday.
> Do not use the corrected form.`);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      title: "upload the corrected form",
      dueDate: "2026-08-13",
    });
  });

  it("understands HTML email lists and strips markup", async () => {
    const result = await extract(`<p>Hi Zach,</p><ul><li>Please review the design notes by Friday.</li><li>Call the adviser tomorrow.</li></ul><p>Thanks!</p>`);

    expect(result.tasks.map((task) => task.title)).toEqual([
      "review the design notes",
      "Call the adviser",
    ]);
    expect(result.tasks.map((task) => task.dueDate)).toEqual([
      "2026-08-14",
      "2026-08-13",
    ]);
  });

  it("attaches wrapped due dates and estimates to the preceding task", async () => {
    const result = await extract(`Task: Review the enclosure design draft
Due: Friday
Estimate: 20 minutes`);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      title: "Review the enclosure design draft",
      dueDate: "2026-08-14",
      estimatedMinutes: 20,
    });
  });

  it("understands Markdown tables without importing the header", async () => {
    const result = await extract(`| Task | Due | Estimate |
| --- | --- | --- |
| Submit the waiver | Aug 15 | 15 minutes |
| Call the adviser | Aug 18 | 20 minutes |`);

    expect(result.tasks.map((task) => task.title)).toEqual([
      "Submit the waiver",
      "Call the adviser",
    ]);
    expect(result.tasks.map((task) => task.estimatedMinutes)).toEqual([15, 20]);
  });

  it("understands CSV-style rows", async () => {
    const result = await extract(`Submit the waiver, Aug 15, 15 minutes
Call the adviser, Aug 18, 20 minutes`);

    expect(result.tasks.map((task) => task.title)).toEqual([
      "Submit the waiver",
      "Call the adviser",
    ]);
  });

  it("splits compact inline numbered lists", async () => {
    const result = await extract(
      "TODO: 1) Submit the transcript by Friday; 2) Call the adviser tomorrow; 3) Book the lab tour Monday",
    );

    expect(result.tasks.map((task) => task.title)).toEqual([
      "Submit the transcript",
      "Call the adviser",
      "Book the lab tour",
    ]);
  });

  it("accepts varied unchecked boxes while ignoring completed boxes", async () => {
    const result = await extract(`☐ Read chapter 1
□ Complete problem set 2
⬜ Email the instructor
[ ] Submit the worksheet
☑ Already completed the quiz
[x] Paid the lab fee
✅ Uploaded the signed form`);

    expect(result.tasks.map((task) => task.title)).toEqual([
      "Read chapter 1",
      "Complete problem set 2",
      "Email the instructor",
      "Submit the worksheet",
    ]);
  });

  it("respects negation and completion while keeping cancellation as an action", async () => {
    const result = await extract(`Do not submit the draft.
No need to reply to this email.
I already paid the invoice.
The report was completed yesterday.
Cancel the dentist appointment Friday.`);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      title: "Cancel the dentist appointment",
      dueDate: "2026-08-14",
    });
  });

  it("applies an agenda date heading to fixed-time rows", async () => {
    const result = await extract(`Agenda for Aug 14
9:00 AM - 9:30 AM Team standup
2:00 PM Dentist appointment`);

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({
      title: "Team standup",
      taskType: "fixed_time",
      estimatedMinutes: 30,
      fixedStartAt: expect.stringContaining("2026-08-14T16:00:00"),
      fixedEndAt: expect.stringContaining("2026-08-14T16:30:00"),
    });
    expect(result.tasks[1]).toMatchObject({
      title: "Dentist appointment",
      taskType: "fixed_time",
      fixedStartAt: expect.stringContaining("2026-08-14T21:00:00"),
    });
  });

  it("strips chat timestamps and names while keeping the request", async () => {
    const result = await extract(
      "[9:04 AM] Maya: Can you upload the revised budget by tomorrow?",
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      title: "upload the revised budget",
      dueDate: "2026-08-13",
    });
  });

  it("handles invisible characters and OCR-like bullets", async () => {
    const result = await extract(
      "•\u200B Submit the safety form 8/15/26\n→\u00A0Call the lab office Monday",
    );

    expect(result.tasks.map((task) => task.title)).toEqual([
      "Submit the safety form",
      "Call the lab office",
    ]);
  });

  it("keeps separate tasks in ordinary prose", async () => {
    const result = await extract(
      "Please review the syllabus by Friday. Call the adviser tomorrow. The office is closed on weekends.",
    );

    expect(result.tasks.map((task) => task.title)).toEqual([
      "review the syllabus",
      "Call the adviser",
    ]);
  });

  it("caps unusually large lists instead of crashing or making interpretation unbounded", async () => {
    const oversized = Array.from(
      { length: 140 },
      (_, index) => `☐ Submit worksheet ${index + 1}`,
    ).join("\n");
    const result = await extract(oversized);

    expect(result.tasks).toHaveLength(100);
    expect(result.tasks[0].title).toBe("Submit worksheet 1");
    expect(result.tasks.at(-1)?.title).toBe("Submit worksheet 100");
  });
});
