import { describe, expect, it } from "vitest";
import { validateAndDedupeExtraction } from "../lib/domain/extraction-schema";
import { generateSchedule } from "../lib/domain/scheduler";
import { finalizeStagedExtraction } from "../lib/providers/staged-extraction";
import { scheduling, task } from "./fixtures";

describe("recurring import representation", () => {
  it("expands an explicit series even when the provider labels its first event fixed_time", () => {
    const output = validateAndDedupeExtraction({tasks:[task({
      id:"practice",title:"Piano practice",taskType:"fixed_time",estimatedMinutes:50,
      fixedStartAt:"2026-07-27T10:00:00Z",fixedEndAt:"2026-07-27T10:50:00Z",
      recurrence:{frequency:"weekly",mode:"fixed_times",daysOfWeek:["monday","thursday"],timeRules:[{daysOfWeek:["monday","thursday"],time:"10:00"}],windowEnd:"2026-07-31T23:59:59Z"},
    })],ignoredStatements:[]});
    expect(output.tasks[0]).toMatchObject({taskType:"recurring_goal",recurrence:{windowStart:"2026-07-27T10:00:00Z"}});
    expect(output.tasks[0].fixedStartAt).toBeUndefined();
    const proposal = generateSchedule(scheduling(output.tasks));
    expect(proposal.sessions.map(s=>s.start)).toEqual(["2026-07-27T10:00:00.000Z","2026-07-30T10:00:00.000Z"]);
  });

  it("keeps different weekday patterns with the same title and shared source through both deduplication stages", () => {
    const text = "Piano practice on Monday and Thursday.";
    const monday = task({id:"mon",title:"Piano practice",sourceText:text,taskType:"recurring_goal",recurrence:{frequency:"weekly",mode:"fixed_times",timeRules:[{daysOfWeek:["monday"],time:"10:00"}]},sourceSpan:{start:0,end:text.length,quote:text}});
    const thursday = {...monday,id:"thu",recurrence:{...monday.recurrence!,timeRules:[{daysOfWeek:["thursday" as const],time:"10:00"}]}};
    const validated = validateAndDedupeExtraction({tasks:[monday,thursday,{...monday,id:"duplicate"}],ignoredStatements:[]});
    expect(validated.tasks).toHaveLength(2);
    const finalized = finalizeStagedExtraction({text,currentLocalDate:"2026-07-27",timeZone:"UTC"},validated,{responsibilities:[],globalInstructions:[]});
    expect(finalized.tasks).toHaveLength(2);
  });
});
