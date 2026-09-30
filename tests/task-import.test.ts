import { describe, expect, it } from "vitest";
import {
  mergeImportedTasks,
  sessionsToPreserveAfterImport,
} from "../lib/domain/task-import";
import { task } from "./fixtures";

describe("responsibility imports", () => {
  it("drops stale sessions when imported fixed timing is refreshed", () => {
    const sessions = [
      { id: "stale", taskId: "refreshed", status: "approved" },
      { id: "history", taskId: "refreshed", status: "completed" },
      { id: "stable", taskId: "unchanged", status: "approved" },
      { id: "removed", taskId: "deleted", status: "approved" },
    ];

    expect(
      sessionsToPreserveAfterImport(
        sessions,
        new Set(["refreshed", "unchanged"]),
        new Set(["refreshed"]),
      ).map((session) => session.id),
    ).toEqual(["history", "stable"]);
  });

  it("adds new responsibilities without replacing existing ones", () => {
    const existing = task({ id: "imported-1", title: "Existing task" });
    const incoming = task({ id: "imported-1", title: "New task" });

    const result = mergeImportedTasks(
      [existing],
      [incoming],
      () => "generated-2",
    );

    expect(result.tasks.map((item) => item.title)).toEqual([
      "Existing task",
      "New task",
    ]);
    expect(result.tasks.map((item) => item.id)).toEqual([
      "imported-1",
      "generated-2",
    ]);
    expect(result.addedTasks).toHaveLength(1);
    expect(result.importedTaskIds).toEqual(["generated-2"]);
    expect(result.refreshedTaskIds).toEqual([]);
  });

  it("does not add the same interpreted responsibility twice", () => {
    const existing = task({ id: "existing", title: "Submit report" });
    const duplicate = task({ id: "another-id", title: "Submit report" });

    const result = mergeImportedTasks([existing], [duplicate]);

    expect(result.tasks).toEqual([existing]);
    expect(result.addedTasks).toEqual([]);
    expect(result.importedTaskIds).toEqual(["existing"]);
    expect(result.duplicateCount).toBe(1);
    expect(result.refreshedTaskIds).toEqual([]);
  });

  it("retains distinct sibling responsibilities that share one source span", () => {
    const sourceText =
      "Finish the motor calculations and assemble the CAD model before Wednesday.";
    const sourceSpan = {
      sourceId: "design-brief",
      start: 0,
      end: sourceText.length,
      quote: sourceText,
    };
    const motor = task({
      id: "motor-calculations",
      title: "Finish motor calculations",
      sourceText,
      sourceSpan,
    });
    const cad = task({
      id: "cad-assembly",
      title: "Assemble CAD model",
      sourceText,
      sourceSpan,
    });

    const result = mergeImportedTasks([], [motor, cad]);

    expect(result.tasks.map((item) => item.id)).toEqual([
      "motor-calculations",
      "cad-assembly",
    ]);
    expect(result.addedTasks).toHaveLength(2);
    expect(result.importedTaskIds).toEqual([
      "motor-calculations",
      "cad-assembly",
    ]);
    expect(result.duplicateCount).toBe(0);
  });

  it("retains same-title occurrences at different fixed times from shared context", () => {
    const sourceText = "Gym Monday at 7:30 PM and Saturday at 5:00 PM.";
    const monday = task({
      id: "monday-gym",
      title: "Gym",
      sourceText,
      taskType: "fixed_time",
      fixedStartAt: "2026-08-31T19:30:00-07:00",
      fixedEndAt: "2026-08-31T20:30:00-07:00",
    });
    const saturday = task({
      id: "saturday-gym",
      title: "Gym",
      sourceText,
      taskType: "fixed_time",
      fixedStartAt: "2026-09-05T17:00:00-07:00",
      fixedEndAt: "2026-09-05T18:00:00-07:00",
    });

    const result = mergeImportedTasks([], [monday, saturday]);

    expect(result.tasks.map((item) => item.id)).toEqual([
      "monday-gym",
      "saturday-gym",
    ]);
    expect(result.duplicateCount).toBe(0);
  });

  it("deduplicates a repeated import without collapsing its same-source siblings", () => {
    const sourceText =
      "Finish the motor calculations and assemble the CAD model before Wednesday.";
    const existing = [
      task({
        id: "saved-motor",
        title: "Finish motor calculations",
        sourceText,
      }),
      task({
        id: "saved-cad",
        title: "Assemble CAD model",
        sourceText,
      }),
    ];
    const repeated = [
      task({
        id: "new-motor-id",
        title: "Finish motor calculations",
        sourceText,
      }),
      task({
        id: "new-cad-id",
        title: "Assemble CAD model",
        sourceText,
      }),
    ];

    const result = mergeImportedTasks(existing, repeated);

    expect(result.tasks).toEqual(existing);
    expect(result.addedTasks).toEqual([]);
    expect(result.importedTaskIds).toEqual(["saved-motor", "saved-cad"]);
    expect(result.duplicateCount).toBe(2);
  });

  it("adds a newly discovered same-source sibling on a later import", () => {
    const sourceText =
      "Finish the motor calculations and assemble the CAD model before Wednesday.";
    const existingMotor = task({
      id: "saved-motor",
      title: "Finish motor calculations",
      sourceText,
    });
    const repeatedMotor = task({
      id: "new-motor-id",
      title: "Finish motor calculations",
      sourceText,
    });
    const newlyDiscoveredCad = task({
      id: "new-cad-id",
      title: "Assemble CAD model",
      sourceText,
    });

    const result = mergeImportedTasks(
      [existingMotor],
      [repeatedMotor, newlyDiscoveredCad],
    );

    expect(result.tasks.map((item) => item.id)).toEqual([
      "saved-motor",
      "new-cad-id",
    ]);
    expect(result.addedTasks).toEqual([newlyDiscoveredCad]);
    expect(result.duplicateCount).toBe(1);
  });

  it("cleans previously misclassified portal navigation without deleting real tasks", () => {
    const navigation = task({
      id: "navigation",
      title: "Purple Prep Checklist",
      sourceText:
        "[Purple Prep Checklist](https://go.sa.northwestern.edu/newstudent/)",
    });
    const monthHeading = task({
      id: "month-heading",
      title: "Due in August",
      sourceText: "Due in August",
    });
    const real = task({ id: "exercise", title: "Exercise" });

    const result = mergeImportedTasks([navigation, monthHeading, real], []);

    expect(result.tasks).toEqual([real]);
    expect(result.removedMetadataCount).toBe(2);
  });

  it("refreshes Markdown-polluted task fields without changing the task identity", () => {
    const sourceText = "**Select a move-in appointment** 8/21/26";
    const existing = task({
      id: "existing-appointment",
      title: "**Select a move-in appointment**",
      sourceText,
      taskType: "fixed_time",
    });
    const corrected = task({
      id: "incoming",
      title: "Select a move-in appointment",
      sourceText,
      taskType: "flexible",
      dueDate: "2026-08-21",
    });

    const result = mergeImportedTasks([existing], [corrected]);

    expect(result.tasks).toEqual([
      expect.objectContaining({
        id: "existing-appointment",
        title: "Select a move-in appointment",
        taskType: "flexible",
        dueDate: "2026-08-21",
      }),
    ]);
    expect(result.importedTaskIds).toEqual(["existing-appointment"]);
    expect(result.refreshedTaskCount).toBe(1);
    expect(result.refreshedTaskIds).toEqual(["existing-appointment"]);
  });

  it("repairs a legacy agenda row without duplicating the responsibility", () => {
    const sourceText = "6:30 PM — Group project meeting";
    const existing = task({
      id: "legacy-meeting",
      title: sourceText,
      sourceText,
      taskType: "fixed_time",
      fixedStartAt: "2026-08-21T01:30:00.000Z",
      fixedEndAt: "2026-08-21T02:30:00.000Z",
    });
    const corrected = task({
      id: "incoming",
      title: "Group project meeting",
      sourceText,
      taskType: "fixed_time",
      fixedStartAt: "2026-08-19T01:30:00.000Z",
      fixedEndAt: "2026-08-19T02:15:00.000Z",
    });

    const result = mergeImportedTasks([existing], [corrected]);

    expect(result.tasks).toEqual([
      expect.objectContaining({
        id: "legacy-meeting",
        title: "Group project meeting",
        fixedStartAt: "2026-08-19T01:30:00.000Z",
        fixedEndAt: "2026-08-19T02:15:00.000Z",
      }),
    ]);
    expect(result.addedTasks).toEqual([]);
    expect(result.refreshedTaskCount).toBe(1);
    expect(result.refreshedTaskIds).toEqual(["legacy-meeting"]);
  });

  it("refreshes corrected timing for an otherwise clean agenda row", () => {
    const sourceText = "6:00 PM — Email Professor Anderson";
    const existing = task({
      id: "existing-email",
      title: "Email Professor Anderson",
      sourceText,
      taskType: "fixed_time",
      fixedStartAt: "2026-08-18T01:00:00.000Z",
      fixedEndAt: "2026-08-18T01:45:00.000Z",
      estimatedMinutes: 45,
    });
    const corrected = task({
      id: "incoming-email",
      title: "Email Professor Anderson",
      sourceText,
      taskType: "fixed_time",
      fixedStartAt: "2026-08-18T01:00:00.000Z",
      fixedEndAt: "2026-08-18T01:30:00.000Z",
      estimatedMinutes: 30,
    });

    const result = mergeImportedTasks([existing], [corrected]);

    expect(result.tasks).toEqual([
      expect.objectContaining({
        id: "existing-email",
        fixedEndAt: "2026-08-18T01:30:00.000Z",
        estimatedMinutes: 30,
      }),
    ]);
    expect(result.refreshedTaskCount).toBe(1);
    expect(result.refreshedTaskIds).toEqual(["existing-email"]);
  });

  it("preserves approval when an agenda row is re-imported unchanged", () => {
    const sourceText = "7:30 PM — Gym";
    const existing = task({
      id: "approved-gym",
      title: "Gym",
      sourceText,
      taskType: "fixed_time",
      fixedStartAt: "2026-08-18T02:30:00.000Z",
      fixedEndAt: "2026-08-18T03:30:00.000Z",
      estimatedMinutes: 60,
      approved: true,
      reviewRequired: false,
    });
    const duplicate = task({
      id: "incoming-gym",
      title: "Gym",
      sourceText,
      taskType: "fixed_time",
      fixedStartAt: existing.fixedStartAt,
      fixedEndAt: existing.fixedEndAt,
      estimatedMinutes: 60,
      approved: false,
      reviewRequired: true,
    });

    const result = mergeImportedTasks([existing], [duplicate]);

    expect(result.tasks).toEqual([existing]);
    expect(result.refreshedTaskCount).toBe(0);
    expect(result.refreshedTaskIds).toEqual([]);
  });

  it("repairs older deadline, event, and dated-preference interpretations in place", () => {
    const proposalSource =
      "Just a reminder that your design proposal is due Friday, September 4 at 11:59 PM.";
    const meetingSource =
      "We’ll meet Thursday at 2 PM for about an hour to go over feedback.";
    const editsSource =
      "If possible, try to make any final edits Thursday evening so you aren’t rushing Friday night.";
    const existing = [
      task({
        id: "proposal",
        title: "Design proposal",
        sourceText: proposalSource,
        dueDate: "2026-09-04",
      }),
      task({
        id: "meeting",
        title: "Go over feedback",
        sourceText: meetingSource,
        dueDate: "2026-09-03",
        dueTime: "14:00",
        dueAt: "2026-09-03T21:00:00.000Z",
      }),
      task({
        id: "edits",
        title: "Make final edits",
        sourceText: editsSource,
        dueDate: "2026-09-03",
      }),
    ];
    const corrected = [
      task({
        id: "new-proposal",
        title: "Submit design proposal",
        sourceText: proposalSource,
        dueDate: "2026-09-04",
        dueTime: "23:59",
        dueAt: "2026-09-05T06:59:00.000Z",
      }),
      task({
        id: "new-meeting",
        title: "Meet to go over feedback",
        sourceText: meetingSource,
        taskType: "fixed_time",
        dueDate: undefined,
        dueTime: undefined,
        dueAt: undefined,
        fixedStartAt: "2026-09-03T21:00:00.000Z",
        fixedEndAt: "2026-09-03T22:00:00.000Z",
        estimatedMinutes: 60,
        effortEstimateSource: "stated",
      }),
      task({
        id: "new-edits",
        title: "Make final edits",
        sourceText: editsSource,
        dueDate: undefined,
        schedulingConstraints: {
          preferredDateWindows: [
            {
              start: "2026-09-04T00:00:00.000Z",
              end: "2026-09-04T04:00:00.000Z",
              label: "Thursday evening",
              precision: "named_period",
            },
          ],
        },
      }),
    ];

    const result = mergeImportedTasks(existing, corrected);

    expect(result.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "proposal",
          dueTime: "23:59",
          dueAt: "2026-09-05T06:59:00.000Z",
        }),
        expect.objectContaining({
          id: "meeting",
          taskType: "fixed_time",
          dueDate: undefined,
          fixedStartAt: "2026-09-03T21:00:00.000Z",
          fixedEndAt: "2026-09-03T22:00:00.000Z",
        }),
        expect.objectContaining({
          id: "edits",
          dueDate: undefined,
          schedulingConstraints: expect.objectContaining({
            preferredDateWindows: [
              expect.objectContaining({ label: "Thursday evening" }),
            ],
          }),
        }),
      ]),
    );
    expect(result.refreshedTaskIds).toEqual([
      "proposal",
      "meeting",
      "edits",
    ]);
    expect(result.addedTasks).toEqual([]);
  });

  it("does not overwrite a user-edited temporal field during correction", () => {
    const sourceText =
      "Just a reminder that your design proposal is due Friday, September 4 at 11:59 PM.";
    const existing = task({
      id: "proposal",
      title: "Design proposal",
      sourceText,
      dueDate: "2026-09-05",
      fieldProvenance: [{ path: "dueDate", origin: "user" }],
    });
    const corrected = task({
      id: "incoming",
      title: "Submit design proposal",
      sourceText,
      dueDate: "2026-09-04",
      dueTime: "23:59",
      dueAt: "2026-09-05T06:59:00.000Z",
    });

    const result = mergeImportedTasks([existing], [corrected]);

    expect(result.tasks).toEqual([existing]);
    expect(result.refreshedTaskIds).toEqual([]);
  });

  it("reports every refreshed identity without mixing in new or unchanged tasks", () => {
    const existingEmail = task({
      id: "existing-email",
      title: "Email Professor Anderson",
      sourceText: "6:00 PM — Email Professor Anderson",
      taskType: "fixed_time",
      fixedStartAt: "2026-08-18T01:00:00.000Z",
      fixedEndAt: "2026-08-18T01:45:00.000Z",
      estimatedMinutes: 45,
    });
    const existingGym = task({
      id: "existing-gym",
      title: "Gym",
      sourceText: "7:30 PM — Gym",
      taskType: "fixed_time",
      fixedStartAt: "2026-08-18T02:30:00.000Z",
      fixedEndAt: "2026-08-18T03:30:00.000Z",
      estimatedMinutes: 60,
    });
    const correctedEmail = task({
      id: "incoming-email",
      title: existingEmail.title,
      sourceText: existingEmail.sourceText,
      taskType: "fixed_time",
      fixedStartAt: "2026-08-25T01:00:00.000Z",
      fixedEndAt: "2026-08-25T01:30:00.000Z",
      estimatedMinutes: 30,
    });
    const unchangedGym = task({
      id: "incoming-gym",
      title: existingGym.title,
      sourceText: existingGym.sourceText,
      taskType: "fixed_time",
      fixedStartAt: existingGym.fixedStartAt,
      fixedEndAt: existingGym.fixedEndAt,
      estimatedMinutes: existingGym.estimatedMinutes,
    });
    const newTask = task({
      id: "incoming-new",
      title: "Call dentist",
      sourceText: "10:00 AM — Call dentist",
    });

    const result = mergeImportedTasks(
      [existingEmail, existingGym],
      [correctedEmail, unchangedGym, newTask],
    );

    expect(result.refreshedTaskIds).toEqual(["existing-email"]);
    expect(result.refreshedTaskCount).toBe(
      result.refreshedTaskIds.length,
    );
    expect(result.importedTaskIds).toEqual([
      "existing-email",
      "existing-gym",
      "incoming-new",
    ]);
    expect(result.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "existing-email",
          fixedStartAt: "2026-08-25T01:00:00.000Z",
        }),
        existingGym,
        expect.objectContaining({ id: "incoming-new" }),
      ]),
    );
  });

  it("replaces prior collapsed learning-plan summaries when checklist items are recovered", () => {
    const collapsedPlan = task({
      id: "collapsed-plan",
      title: "Complete 12-Week Electronics Cooling Learning Plan",
      sourceText: "12-Week Electronics Cooling Learning Plan",
      taskType: "recurring_goal",
    });
    const collapsedChecklist = task({
      id: "collapsed-checklist",
      title: "Daily checklist",
      sourceText: "Daily checklist:",
      taskType: "recurring_goal",
    });
    const unrelated = task({ id: "exercise", title: "Exercise" });
    const recovered = task({
      id: "structured-plan-w001-d001",
      title: "Week 1, Day 1: Read the course overview",
      sourceText:
        "Week 1 — Heat Transfer Fundamentals\n☐ Day 1: Read the course overview.",
    });

    const result = mergeImportedTasks(
      [collapsedPlan, collapsedChecklist, unrelated],
      [recovered],
    );

    expect(result.tasks.map((item) => item.title)).toEqual([
      "Exercise",
      "Week 1, Day 1: Read the course overview",
    ]);
    expect(result.removedMetadataCount).toBe(2);
  });
});
