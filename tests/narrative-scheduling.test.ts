import { addDays, format, parseISO } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES } from "../lib/defaults";
import { generateSchedule } from "../lib/domain/scheduler";
import type { ExtractionInput } from "../lib/domain/types";
import { recoverNarrativeSchedulingIntent } from "../lib/providers/narrative-scheduling-recovery";

const NARRATIVE = `This week is pretty busy. I need to finish my physics problem set by Friday night. It’ll probably take around 2 hours, but I’d rather split it into two sessions.

I also need to call the dentist sometime this week to schedule a cleaning. They’re only open from 9 AM–5 PM, and the call should only take like 10 minutes.

I have a group project meeting Thursday at 6:30 PM for about an hour. Before that, I should spend around 45 minutes reviewing our slides so I actually know what we’re talking about.

Need to go to the gym 4 times this week. Each workout is around 1 hour 15 minutes. I prefer going sometime between 4 and 8 PM, but it doesn’t really matter. Don’t schedule workouts back-to-back days if possible.

I have a calculus quiz Monday morning, so I want to study about 3 hours total beforehand. Break that into sessions instead of doing it all Sunday night.

My room is also getting kinda messy. Cleaning it should take 30–45 minutes. No real deadline, just fit it somewhere when I’m not busy.

I need groceries before Sunday because I’m almost out of food. Grocery shopping takes around 1 hour, and I’d rather do it in the afternoon.

Email Professor Anderson about the research opportunity. This is pretty important and should probably be done by Wednesday. Maybe 15–20 minutes because I want to write a decent email.

I want to work on my coding side project too, but there’s no deadline. Try to give me 2 or 3 sessions this week of at least an hour each, but school stuff should take priority.

Friday night after 8 PM I want to keep completely free.

Saturday I’m hanging out with friends from around 5 PM until late, so don’t schedule anything then.

I usually wake up around 8 AM and go to sleep around midnight. I don’t really want work scheduled before 9 AM.

Also remind me to order more contact lenses sometime this week. Takes maybe 10 minutes and isn’t urgent.`;

const input: ExtractionInput = {
  text: NARRATIVE,
  currentLocalDate: "2026-08-12",
  timeZone: "America/Los_Angeles",
};

function interpreted() {
  return recoverNarrativeSchedulingIntent(input, {
    tasks: [],
    ignoredStatements: [],
  });
}

function task(title: RegExp) {
  return interpreted().tasks.find((item) => title.test(item.title));
}

describe("narrative scheduling intent", () => {
  it("separates every responsibility and preserves global schedule rules", () => {
    const result = interpreted();

    expect(result.tasks).toHaveLength(13);
    expect(result.planningRules).toMatchObject({
      earliestWorkTime: "09:00",
      latestWorkTime: "00:00",
      blockedTimes: [
        {
          start: "2026-08-15T03:00:00.000Z",
          end: "2026-08-15T07:00:00.000Z",
          label: "Protected free time",
        },
      ],
    });
  });

  it("captures hard windows, soft preferences, splitting, spacing, and prerequisites", () => {
    expect(task(/physics problem set/i)).toMatchObject({
      dueDate: "2026-08-14",
      estimatedMinutes: 120,
      splittable: true,
      minimumSessionMinutes: 60,
      schedulingConstraints: { sessionCount: 2 },
    });
    expect(task(/dentist/i)).toMatchObject({
      estimatedMinutes: 10,
      schedulingConstraints: {
        allowedTimeWindows: [{ start: "09:00", end: "17:00" }],
      },
    });
    expect(task(/gym workout/i)).toMatchObject({
      estimatedMinutes: 75,
      recurrence: { mode: "quota", count: 4 },
      schedulingConstraints: {
        preferredTimeWindows: [{ start: "16:00", end: "20:00" }],
        avoidConsecutiveDays: true,
      },
    });
    expect(task(/review group project slides/i)?.dueAt).toBe(
      task(/group project meeting/i)?.fixedStartAt,
    );
    expect(task(/study for calculus/i)).toMatchObject({
      dueDate: "2026-08-17",
      dueTime: "09:00",
      estimatedMinutes: 180,
      splittable: true,
    });
    expect(task(/^calculus quiz$/i)).toMatchObject({
      reviewRequired: true,
      approved: false,
    });
    expect(task(/coding side project/i)).toMatchObject({
      priority: "low",
      estimatedMinutes: 60,
      minimumSessionMinutes: 60,
      recurrence: { mode: "quota", count: 2 },
    });
  });

  it("produces a schedule that enforces the interpreted requirements", () => {
    const result = interpreted();
    const rules = result.planningRules!;
    const availability = Array.from({ length: 7 }, (_, index) => {
      const date = format(addDays(parseISO(input.currentLocalDate), index), "yyyy-MM-dd");
      const next = format(addDays(parseISO(date), 1), "yyyy-MM-dd");
      return {
        start: fromZonedTime(`${date}T09:00:00`, input.timeZone).toISOString(),
        end: fromZonedTime(`${next}T00:00:00`, input.timeZone).toISOString(),
      };
    });
    const proposal = generateSchedule({
      windowStart: availability[0].start,
      windowEnd: availability.at(-1)!.end,
      tasks: result.tasks,
      preferences: {
        ...DEFAULT_PREFERENCES,
        wakingTime: rules.earliestWorkTime!,
        sleepingTime: rules.latestWorkTime!,
      },
      availability,
      unavailableEvents: [],
      blockedTimes: rules.blockedTimes!.map(({ start, end }) => ({ start, end })),
      lockedSessions: [],
    });
    const sessionsFor = (pattern: RegExp) =>
      proposal.sessions.filter((session) => pattern.test(session.title));

    expect(sessionsFor(/physics problem set/i).map((session) => session.minutes)).toEqual([60, 60]);
    expect(
      sessionsFor(/dentist/i).every((session) => {
        const hour = Number(
          new Intl.DateTimeFormat("en-US", {
            timeZone: input.timeZone,
            hour: "2-digit",
            hourCycle: "h23",
          }).format(new Date(session.start)),
        );
        return hour >= 9 && hour < 17;
      }),
    ).toBe(true);
    const meetingStart = sessionsFor(/group project meeting/i)[0]?.start;
    expect(
      sessionsFor(/review group project slides/i).every(
        (session) => new Date(session.end) <= new Date(meetingStart),
      ),
    ).toBe(true);
    expect(
      sessionsFor(/study for calculus/i).every(
        (session) => new Date(session.end) <= new Date("2026-08-17T16:00:00.000Z"),
      ),
    ).toBe(true);
    expect(
      proposal.sessions.filter((session) => !/hang out with friends/i.test(session.title)).every(
        (session) =>
          new Date(session.end) <= new Date("2026-08-15T03:00:00.000Z") ||
          new Date(session.start) >= new Date("2026-08-15T07:00:00.000Z"),
      ),
    ).toBe(true);
  });
});
