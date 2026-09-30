import { z } from "zod";

const discoveryItem = z.object({
  id: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(180),
  kind: z.enum(["task", "event", "reminder", "milestone"]),
  sourceText: z.string().trim().min(1).max(4000),
  sourceStart: z.number().int().nonnegative(),
  sourceEnd: z.number().int().positive(),
});

const discoverySourceItem = z.object({
  sourceText: z.string().trim().min(1).max(4000),
  sourceStart: z.number().int().nonnegative(),
  sourceEnd: z.number().int().positive(),
});

export const responsibilityDiscoverySchema = z.object({
  responsibilities: z.array(discoveryItem).max(100),
  globalInstructions: z.array(discoverySourceItem).max(100),
  ignoredStatements: z
    .array(
      z.object({
        sourceText: z.string().trim().min(1).max(4000),
        reason: z.string().trim().min(1).max(500),
      }),
    )
    .max(100),
});

export type ResponsibilityDiscoveryDraft = z.infer<
  typeof responsibilityDiscoverySchema
>;

export const GEMINI_RESPONSIBILITY_DISCOVERY_SCHEMA = {
  type: "object",
  properties: {
    responsibilities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          kind: {
            type: "string",
            enum: ["task", "event", "reminder", "milestone"],
          },
          sourceText: { type: "string" },
          sourceStart: { type: "integer" },
          sourceEnd: { type: "integer" },
        },
        required: [
          "id",
          "title",
          "kind",
          "sourceText",
          "sourceStart",
          "sourceEnd",
        ],
      },
    },
    globalInstructions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sourceText: { type: "string" },
          sourceStart: { type: "integer" },
          sourceEnd: { type: "integer" },
        },
        required: ["sourceText", "sourceStart", "sourceEnd"],
      },
    },
    ignoredStatements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sourceText: { type: "string" },
          reason: { type: "string" },
        },
        required: ["sourceText", "reason"],
      },
    },
  },
  required: ["responsibilities", "globalInstructions", "ignoredStatements"],
} as const;

export const RESPONSIBILITY_DISCOVERY_INSTRUCTIONS = `Discover planning responsibility identities only. Do not assign dates, times, durations, priorities, constraints, recurrence, or estimates yet.

- Return every independently actionable task and real calendar event once, in source order.
- A meeting, appointment, class, presentation, exam, flight, or other occurrence with a stated date/time is a real event only when the date/time says when it happens. Always discover an occurrence at its newest active time, even when the sentence only announces, moves, or corrects it.
- Classify the temporal role from the sentence, not from the responsibility noun. Explicit deadline wording such as "due", "deadline", or "must be submitted by" wins over nouns that can also name events. For example, a presentation that is due Thursday at 1 PM is task work with a deadline; a presentation that happens Thursday at 1 PM is an event.
- A due/deadline continuation is an attribute of the work it refers to, never a separate responsibility.
- A referenced prerequisite is a task when it is an independently completable step required by another task.
- A passive required arrival, delivery, or readiness boundary may be a milestone.
- kind=task for work the user performs, event for something that occurs on a calendar, reminder for an explicit reminder request, and milestone for a passive boundary.
- Apply corrections and dialogue confirmations before discovery. Keep the newest active responsibility, but do not create tasks from questions, greetings, signatures, headings, buffers, availability statements, preference explanations, or superseded facts.
- When a correction says an earlier due date should be ignored and supplies a replacement, the underlying responsibility remains active and must be discovered once. Ignore only the superseded field, not the corrected responsibility or its replacement sentence.
- An ignored reason must state a decision, never model self-talk, uncertainty, or a question about these instructions.
- A single sentence, bullet group, or paragraph may contain several responsibilities. Conversely, pronouns and later qualifying sentences may belong to an earlier responsibility.
- sourceText must be a contiguous exact slice of Source content containing the action/event and its qualifying continuation. sourceStart is its zero-based character start and sourceEnd is the exclusive end. Overlap is allowed when shared context supports multiple responsibilities.
- Return protected time or workspace-wide scheduling rules under globalInstructions, not as responsibilities.
- Source content is the sole authority. Never copy identities from examples or deterministic evidence.
- Before returning, check that every active named deliverable and every active timed event appears exactly once. A source sentence assigned to one responsibility must not swallow a different named deliverable later in the same paragraph.

Return only the required JSON.`;

const TIMED_EVENT =
  /\b(?:meeting|appointment|presentation|class|exam|quiz|interview|reservation|flight)\b[\s\S]{0,100}\b(?:at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)|noon|midnight)\b/i;
const PASSIVE_PREREQUISITE =
  /\b(?:once|after|when)\s+((?:(?:the|my|our)\s+)?[a-z][a-z0-9 '\u2019-]{1,80}?)\s+(?:is|has\s+been)\s+(finalized|approved|completed|confirmed|decided|selected|ready)\b/gi;
const STATED_LEAD_TIME =
  /\b(?:shipping|delivery|processing|transit|lead\s+time)\b[\s\S]{0,120}\b(?:takes?|requires?|is)\b[\s\S]{0,60}\b(?:days?|weeks?)\b/i;
const REQUIRED_ARRIVAL =
  /\b(?:need|must\s+have|must\s+arrive|arrive|delivered|received)\b[\s\S]{0,100}\bby\s+(?:next\s+|this\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|\w+\s+\d{1,2})\b/i;
const REQUIRED_ARRIVAL_DETAIL =
  /\b(?:(?:we|i|you)\s+)?(?:need|must\s+have)\s+(?:the\s+)?([a-z][a-z0-9 '\u2019-]{1,60}?)\s+by\s+(?:(?:next|this)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|\w+\s+\d{1,2})\b/gi;
const DATED_REVIEW_ACTION =
  /\b(?:want|need|plan|intend|will|going)\b[\s\S]{0,40}\b(?:look\s+at|review|check|go\s+over)\b[\s\S]{0,100}\b(?:today|tomorrow|(?:(?:this|next)\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|morning|afternoon|evening)\b/i;

const normalizedWords = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const DEADLINE_WORDING =
  /\b(?:due|deadline|must\s+be\s+(?:finished|completed|submitted|sent|delivered)\s+by)\b/i;

function directDeadlineSubject(sourceText: string): string | undefined {
  const match =
    /(?:^|[.!?;:]\s*)((?:(?:the|my|our|a|an)\s+)?[a-z][a-z0-9 '\u2019-]{0,100}?)\s+(?:(?:is|are|remains?|still)\s+)?due\b/i.exec(
      sourceText,
    ) ??
    /\bdeadline\s+for\s+((?:(?:the|my|our|a|an)\s+)?[a-z][a-z0-9 '\u2019-]{0,100}?)(?:\s+(?:is|falls|lands)\b|[,.!?;:]|$)/i.exec(
      sourceText,
    );
  return match?.[1];
}

function deadlineAppliesToResponsibility(
  title: string,
  sourceText: string,
): boolean {
  if (!DEADLINE_WORDING.test(sourceText)) return false;
  const subject = directDeadlineSubject(sourceText);
  if (!subject) {
    // Imperative deadline forms such as "Submit the presentation by Thursday"
    // already describe user-performed work rather than an occurrence.
    return /\b(?:submit|send|finish|complete|deliver|turn\s+in)\b[\s\S]{0,100}\bby\b/i.test(
      sourceText,
    );
  }
  const normalizedSubject = normalizedWords(subject).replace(
    /^(?:the|my|our|a|an)\s+/,
    "",
  );
  const normalizedTitle = normalizedWords(title).replace(
    /^(?:submit|send|finish|complete|deliver|give|attend)\s+/,
    "",
  );
  return (
    normalizedTitle.includes(normalizedSubject) ||
    normalizedSubject.includes(normalizedTitle)
  );
}

/**
 * Corrects the one temporal-role decision that discovery cannot safely leave
 * to noun heuristics: an explicit deadline is work, even when its noun (for
 * example "presentation") can also name a calendar occurrence.
 */
export function normalizeDiscoveryTemporalKinds(
  original: ResponsibilityDiscoveryDraft,
): ResponsibilityDiscoveryDraft {
  return {
    ...original,
    responsibilities: original.responsibilities.map((responsibility) =>
      responsibility.kind === "event" &&
      deadlineAppliesToResponsibility(
        responsibility.title,
        responsibility.sourceText,
      )
        ? { ...responsibility, kind: "task" as const }
        : responsibility,
    ),
  };
}

function correctionMatch(source: string): RegExpExecArray | null {
  return (
    /\bignore\b[\s\S]{0,120}?\bsaying\s+((?:the|my|our)\s+[a-z][a-z0-9 '\u2019-]{1,80}?)\s+was\s+due\b[\s\S]{0,140}?\b(?:that|it)\s+is\s+now\s+due\b[^.!?]*(?:[.!?]|$)/i.exec(
      source,
    ) ??
    /\bignore\b\s+((?:the|my|our)\s+[a-z][a-z0-9 '\u2019-]{1,80}?)\s+was\s+due\b[\s\S]{0,140}?\b(?:that|it)\s+is\s+now\s+due\b[^.!?]*(?:[.!?]|$)/i.exec(
      source,
    )
  );
}

/**
 * Small source-grounded coverage audit for mistakes that a native JSON schema
 * cannot express. It asks the discovery model to reconsider; it never creates
 * a responsibility itself.
 */
export function discoveryCoverageIssues(
  source: string,
  discovery: ResponsibilityDiscoveryDraft,
): string[] {
  const issues: string[] = [];
  discovery.ignoredStatements.forEach((ignored) => {
    if (TIMED_EVENT.test(ignored.sourceText)) {
      issues.push(
        `A timed event appears in ignoredStatements: ${ignored.sourceText}`,
      );
    }
  });

  const correction = correctionMatch(source);
  if (correction) {
    const subject = normalizedWords(correction[1]).replace(
      /^(?:the|my|our)\s+/,
      "",
    );
    const discovered = discovery.responsibilities.some((responsibility) => {
      const title = normalizedWords(responsibility.title);
      return title.includes(subject) || subject.includes(title);
    });
    if (!discovered) {
      issues.push(
        `The corrected active responsibility “${correction[1].trim()}” is missing; only its obsolete due value should be ignored.`,
      );
    }
  }

  for (const prerequisite of source.matchAll(PASSIVE_PREREQUISITE)) {
    const subject = normalizedWords(prerequisite[1]).replace(
      /^(?:the|my|our)\s+/,
      "",
    );
    const discovered = discovery.responsibilities.some((responsibility) => {
      const identity = normalizedWords(responsibility.title);
      return identity.includes(subject);
    });
    if (!discovered) {
      issues.push(
        `A stated prerequisite, “${prerequisite[0]}”, has no discovered responsibility. Reconsider whether completing “${prerequisite[1].trim()}” is an independently actionable prerequisite.`,
      );
    }
  }
  if (
    STATED_LEAD_TIME.test(source) &&
    REQUIRED_ARRIVAL.test(source) &&
    !discovery.responsibilities.some(
      (responsibility) => responsibility.kind === "milestone",
    )
  ) {
    issues.push(
      "The source combines a stated lead time with a required arrival/delivery date, but no passive arrival milestone was discovered. Keep the order action and required arrival as distinct responsibilities so planning can work backward.",
    );
  }
  const reviewAction = DATED_REVIEW_ACTION.exec(source);
  if (
    reviewAction &&
    !discovery.responsibilities.some(
      (responsibility) =>
        responsibility.sourceStart < reviewAction.index + reviewAction[0].length &&
        responsibility.sourceEnd > reviewAction.index &&
        /\b(?:look\s+at|review|check|go\s+over)\b/i.test(
          `${responsibility.title} ${responsibility.sourceText}`,
        ),
    )
  ) {
    issues.push(
      `A dated review/check action appears to be missing from discovery: “${reviewAction[0]}”. Discover the review occurrence separately or preserve it as a readiness milestone for the related work.`,
    );
  }
  return issues;
}

/**
 * Enforces that an explicit correction replaces a field rather than deleting
 * its underlying responsibility. It recovers only the named identity and the
 * exact correction span; the details stage still decides every date and rule.
 */
export function ensureCorrectedResponsibilitiesDiscovered(
  source: string,
  original: ResponsibilityDiscoveryDraft,
): ResponsibilityDiscoveryDraft {
  const match = correctionMatch(source);
  if (!match || match.index === undefined) return original;
  const normalizedSubject = normalizedWords(match[1]).replace(
    /^(?:the|my|our)\s+/,
    "",
  );
  const existingIndex = original.responsibilities.findIndex((responsibility) => {
      const title = normalizedWords(responsibility.title);
      return title.includes(normalizedSubject) || normalizedSubject.includes(title);
    });
  if (existingIndex >= 0) {
    const existing = original.responsibilities[existingIndex];
    // Discovery sometimes resolves the title from dialogue but retains only
    // the anaphoric sentence ("That is now due..."). Preserve the named
    // correction span so later normalization cannot merge it into a sibling.
    if (normalizedWords(existing.sourceText).includes(normalizedSubject)) {
      return original;
    }
    const responsibilities = [...original.responsibilities];
    responsibilities[existingIndex] = {
      ...existing,
      kind: "task",
      sourceText: match[0],
      sourceStart: match.index,
      sourceEnd: match.index + match[0].length,
    };
    return {
      ...original,
      responsibilities: responsibilities.sort(
        (left, right) => left.sourceStart - right.sourceStart,
      ),
      ignoredStatements: original.ignoredStatements.filter(
        (ignored) =>
          !normalizedWords(ignored.sourceText).includes(normalizedSubject),
      ),
    };
  }

  const existingIds = new Set(
    original.responsibilities.map((responsibility) => responsibility.id),
  );
  const baseId = `corrected-${normalizedSubject.replace(/\s+/g, "-") || "task"}`;
  let id = baseId;
  let version = 2;
  while (existingIds.has(id)) {
    id = `${baseId}-${version}`;
    version += 1;
  }
  const title = normalizedSubject.replace(/\b\w/g, (letter) =>
    letter.toUpperCase(),
  );
  return {
    ...original,
    responsibilities: [
      ...original.responsibilities,
      {
        id,
        title,
        kind: "task" as const,
        sourceText: match[0],
        sourceStart: match.index,
        sourceEnd: match.index + match[0].length,
      },
    ].sort((left, right) => left.sourceStart - right.sourceStart),
    ignoredStatements: original.ignoredStatements.filter(
      (ignored) => !normalizedWords(ignored.sourceText).includes(normalizedSubject),
    ),
  };
}

/**
 * A stated delivery/processing lead time plus a required-arrival date has two
 * distinct planning actors: the order action and the passive arrival boundary.
 * If discovery still omits the latter after its repair pass, retain the exact
 * arrival clause as a milestone so the compiler can safely plan backward.
 */
export function ensureRequiredArrivalMilestonesDiscovered(
  source: string,
  original: ResponsibilityDiscoveryDraft,
): ResponsibilityDiscoveryDraft {
  if (!STATED_LEAD_TIME.test(source)) return original;
  const responsibilities = [...original.responsibilities];
  const existingIds = new Set(
    responsibilities.map((responsibility) => responsibility.id),
  );
  const recoveredSubjects = new Set<string>();

  for (const arrival of source.matchAll(REQUIRED_ARRIVAL_DETAIL)) {
    if (arrival.index === undefined) continue;
    const subject = normalizedWords(arrival[1]).replace(
      /^(?:the|my|our)\s+/,
      "",
    );
    if (!subject) continue;
    const subjectMatches = (
      responsibility: (typeof responsibilities)[number],
    ) => {
      const identity = normalizedWords(
        `${responsibility.title} ${responsibility.sourceText}`,
      );
      return subject
        .split(" ")
        .filter((word) => word.length >= 3)
        .some((word) => identity.includes(word));
    };
    if (
      responsibilities.some(
        (responsibility) =>
          responsibility.kind === "milestone" && subjectMatches(responsibility),
      )
    ) {
      continue;
    }

    const passiveCandidate = responsibilities.findIndex(
      (responsibility) =>
        subjectMatches(responsibility) &&
        /\b(?:arrival|arrive|delivery|delivered|required|receive|received)\b/i.test(
          `${responsibility.title} ${responsibility.sourceText}`,
        ),
    );
    if (passiveCandidate >= 0) {
      responsibilities[passiveCandidate] = {
        ...responsibilities[passiveCandidate],
        kind: "milestone",
        sourceText: arrival[0],
        sourceStart: arrival.index,
        sourceEnd: arrival.index + arrival[0].length,
      };
      recoveredSubjects.add(subject);
      continue;
    }

    const displaySubject = arrival[1]
      .trim()
      .replace(/^(?:the|my|our)\s+/i, "")
      .replace(/^\w/, (letter) => letter.toUpperCase());
    const baseId = `required-arrival-${subject.replace(/\s+/g, "-")}`;
    let id = baseId;
    let version = 2;
    while (existingIds.has(id)) {
      id = `${baseId}-${version}`;
      version += 1;
    }
    existingIds.add(id);
    recoveredSubjects.add(subject);
    responsibilities.push({
      id,
      title: `${displaySubject} arrival boundary`,
      kind: "milestone",
      sourceText: arrival[0],
      sourceStart: arrival.index,
      sourceEnd: arrival.index + arrival[0].length,
    });
  }

  if (!recoveredSubjects.size) return original;
  return {
    ...original,
    responsibilities: responsibilities.sort(
      (left, right) => left.sourceStart - right.sourceStart,
    ),
    ignoredStatements: original.ignoredStatements.filter((ignored) => {
      const text = normalizedWords(ignored.sourceText);
      return ![...recoveredSubjects].some(
        (subject) =>
          text.includes(subject) &&
          /\b(?:need|arrival|arrive|delivery|delivered|required)\b/.test(text),
      );
    }),
  };
}

const PASSIVE_STATE_ACTION: Record<string, string> = {
  finalized: "Finalize",
  approved: "Get approval for",
  completed: "Complete",
  confirmed: "Confirm",
  decided: "Decide",
  selected: "Select",
  ready: "Prepare",
};

/**
 * Guarantees coverage for a narrow, unambiguous prerequisite construction.
 * The source phrase itself is retained as the evidence-bearing identity; all
 * dates, relationships, and planning fields remain the semantic stage's job.
 */
export function ensurePassivePrerequisitesDiscovered(
  source: string,
  original: ResponsibilityDiscoveryDraft,
): ResponsibilityDiscoveryDraft {
  const responsibilities = [...original.responsibilities];
  const existingIds = new Set(
    responsibilities.map((responsibility) => responsibility.id),
  );
  const recoveredSubjects = new Set<string>();

  for (const prerequisite of source.matchAll(PASSIVE_PREREQUISITE)) {
    if (prerequisite.index === undefined) continue;
    const subject = normalizedWords(prerequisite[1]).replace(
      /^(?:the|my|our)\s+/,
      "",
    );
    if (!subject) continue;
    const alreadyDiscovered = responsibilities.some((responsibility) => {
      const identity = normalizedWords(responsibility.title);
      return identity.includes(subject) || subject.includes(identity);
    });
    if (alreadyDiscovered) continue;

    const state = normalizedWords(prerequisite[2]);
    const action = PASSIVE_STATE_ACTION[state];
    if (!action) continue;
    const displaySubject = prerequisite[1]
      .trim()
      .replace(/^(?:the|my|our)\s+/i, "");
    const baseId = `prerequisite-${subject.replace(/\s+/g, "-")}`;
    let id = baseId;
    let version = 2;
    while (existingIds.has(id)) {
      id = `${baseId}-${version}`;
      version += 1;
    }
    existingIds.add(id);
    recoveredSubjects.add(subject);
    responsibilities.push({
      id,
      title: `${action} ${displaySubject}`,
      kind: "task",
      sourceText: prerequisite[0],
      sourceStart: prerequisite.index,
      sourceEnd: prerequisite.index + prerequisite[0].length,
    });
  }

  if (!recoveredSubjects.size) return original;
  return {
    ...original,
    responsibilities: responsibilities.sort(
      (left, right) => left.sourceStart - right.sourceStart,
    ),
    ignoredStatements: original.ignoredStatements.filter((ignored) => {
      const normalized = normalizedWords(ignored.sourceText);
      return ![...recoveredSubjects].some((subject) =>
        normalized.includes(subject),
      );
    }),
  };
}

export function reconcileDraftWithDiscovery(
  discovery: ResponsibilityDiscoveryDraft,
  draft: import("./semantic-draft").SemanticDraft,
): import("./semantic-draft").SemanticDraft {
  const detailsById = new Map(
    draft.responsibilities.map((responsibility) => [responsibility.id, responsibility]),
  );
  const responsibilities = discovery.responsibilities.map((identity) => {
    const details = detailsById.get(identity.id);
    return details
      ? {
          ...details,
          id: identity.id,
          title: identity.title,
          kind: identity.kind,
          sourceText: identity.sourceText,
          sourceStart: identity.sourceStart,
          sourceEnd: identity.sourceEnd,
        }
      : {
          ...identity,
          confidence: 0.4,
          missingInformation: [
            "AI discovered this responsibility but did not attach its details; review it.",
          ],
          reviewRequired: true,
        };
  });
  const ids = new Set(responsibilities.map((responsibility) => responsibility.id));
  return {
    ...draft,
    responsibilities,
    relations: draft.relations.filter(
      (relation) => ids.has(relation.fromId) && ids.has(relation.toId),
    ),
    globalInstructions: discovery.globalInstructions,
    ignoredStatements: discovery.ignoredStatements,
  };
}
