"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { addDays, format, parseISO } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { DEFAULT_PREFERENCES } from "@/lib/defaults";
import {
  extractionFailureMessage,
  extractionFallbackNotice,
  type ExtractionFallbackReason,
  type ExtractionPipelineReport,
} from "@/lib/domain/extraction-diagnostics";
import { generateSchedule } from "@/lib/domain/scheduler";
import { applyLinkedTaskEdit, recalculateLinkedTiming } from "@/lib/domain/linked-timing";
import { withUserFieldProvenance } from "@/lib/domain/task-provenance";
import {
  latestSequenceTargetDate,
  taskSequence,
} from "@/lib/domain/task-sequence";
import {
  mergeImportedTasks,
  sessionsToPreserveAfterImport,
} from "@/lib/domain/task-import";
import { mergeImportedPlanningRules } from "@/lib/domain/planning-rules";
import {
  deadlineUpdateFields,
  intervalOverlapsManualPlacement,
  isManualPlacementAfterDeadline,
  manuallyPlacedBreak,
  manuallyPlacedSession,
  sessionsForManualPlacementReflow,
  type ManualDeadlineUpdate,
} from "@/lib/domain/manual-placement";
import {
  popPlanningUndo,
  pushPlanningUndo,
  type PlanningUndoSnapshot,
} from "@/lib/domain/planning-undo";
import { proposeMinimalReplan } from "@/lib/domain/rescheduler";
import {
  canRecordSessionOutcome,
  createSessionReview,
  sessionCheckIns,
  type SessionCheckIn,
} from "@/lib/domain/session-review";
import {
  parsePersistedWorkspace,
  type ExtractionMode,
} from "@/lib/domain/workspace-state";
import type {
  ExistingSession,
  ExtractedTask,
  HistoryItem,
  InterpretationTrace,
  PlannedSession,
  PlanningMode,
  PlanningRules,
  ReplanProposal,
  ScheduleProposal,
  ScheduledBreak,
  SchedulingInput,
  SessionOutcome,
  SessionReview,
} from "@/lib/domain/types";
import type { DocumentReference } from "@/lib/domain/document-import";
import { attachDocumentSource } from "@/lib/domain/document-import";

type ImportState = "idle" | "loading" | "success" | "error";

// Theme preference lives in the browser (not the workspace) so it survives
// navigation and refreshes without touching the data model.
type Theme = "light" | "dark";
const THEME_STORAGE_KEY = "planpilot-theme";
const themeListeners = new Set<() => void>();
// Dark is the default look; light is an explicit choice.
function readTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
function subscribeTheme(listener: () => void) {
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}
function writeTheme(next: Theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // Storage may be unavailable (private mode); the class still applies for this page.
  }
  document.documentElement.classList.toggle("dark", next === "dark");
  themeListeners.forEach((listener) => listener());
}
type WorkspaceStatus = "loading" | "ready" | "error";

type PlanPilotContextValue = {
  tasks: ExtractedTask[];
  lastImportedTaskIds: string[];
  proposal: ScheduleProposal;
  importText: string;
  setImportText: (text: string) => void;
  setImportDocumentSource: (source?: DocumentReference) => void;
  importState: ImportState;
  extractionMode?: ExtractionMode;
  extractionReport?: ExtractionPipelineReport;
  importError?: string;
  interpretationTrace?: InterpretationTrace;
  analyzeText: (instructions?: { globalInstructions?: string; allowInlineGlobalInstructions?: boolean }) => Promise<void>;
  updateTask: (id: string, patch: Partial<ExtractedTask>) => void;
  setSequenceStartDate: (groupId: string, date?: string) => void;
  approveTask: (id: string) => void;
  deleteTask: (id: string) => void;
  deleteTasks: (ids: string[]) => void;
  approveSession: (id: string) => void;
  approveAllSessions: () => void;
  toggleSessionLock: (id: string) => void;
  rejectSession: (id: string) => void;
  requestAnotherTime: (id: string) => void;
  placeSessionManually: (
    id: string,
    start: string,
    deadlineUpdate?: ManualDeadlineUpdate,
  ) => void;
  selectedSessionIds: string[];
  toggleSelectedSession: (id: string) => void;
  exportApprovedSessions: () => Promise<void>;
  exportState: "idle" | "loading" | "success" | "error";
  replan?: ReplanProposal;
  applyReplan: () => void;
  reviewQueue: SessionCheckIn[];
  sessionReviews: SessionReview[];
  reviewSession: (
    sessionId: string,
    outcome: SessionOutcome,
    minutesCompleted?: number,
  ) => void;
  delaySessionReview: (sessionId: string) => void;
  history: HistoryItem[];
  planningMode: PlanningMode;
  planningRules: PlanningRules;
  setPlanningMode: (mode: PlanningMode) => void;
  canUndoSchedule: boolean;
  undoScheduleLabel?: string;
  undoSchedule: () => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  clearWorkspace: () => void;
  workspaceStatus: WorkspaceStatus;
  toast?: string;
  clearToast: () => void;
};

const Context = createContext<PlanPilotContextValue | null>(null);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const CURRENT_SCHEDULER_VERSION = 14;
const PLAN_START_DATE_REQUIREMENT = "Choose a plan start date";

function isPlanStartDateRequirement(value: string): boolean {
  return /^choose (?:a )?(?:plan )?start date$/i.test(value.trim());
}

function currentLocalDate(timeZone: string, instant = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function localClockMinutes(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const value = (type: "hour" | "minute") =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return value("hour") * 60 + value("minute");
}

function sessionFitsTaskHours(
  task: ExtractedTask | undefined,
  start: number,
  end: number,
): boolean {
  const windows = task?.schedulingConstraints?.allowedTimeWindows;
  if (!windows?.length) return true;
  const startMinute = localClockMinutes(start, DEFAULT_PREFERENCES.timeZone);
  const duration = Math.round((end - start) / MINUTE);
  return windows.some((window) => {
    const [startHour, startMinutes] = window.start.split(":").map(Number);
    const [endHour, endMinutes] = window.end.split(":").map(Number);
    const windowStart = startHour * 60 + startMinutes;
    const rawEnd = endHour * 60 + endMinutes;
    const windowEnd = rawEnd <= windowStart ? rawEnd + 24 * 60 : rawEnd;
    const candidateStart =
      startMinute < windowStart && windowEnd > 24 * 60
        ? startMinute + 24 * 60
        : startMinute;
    return candidateStart >= windowStart && candidateStart + duration <= windowEnd;
  });
}

function schedulingBase(
  planningMode: PlanningMode,
  tasks: ExtractedTask[] = [],
  lockedSessions: ExistingSession[] = [],
  protectedBreaks: ScheduledBreak[] = [],
  planningRules: PlanningRules = {},
): Omit<SchedulingInput, "tasks"> {
  const now = new Date(Math.ceil(Date.now() / (15 * MINUTE)) * 15 * MINUTE);
  const planningLocalDate = currentLocalDate(DEFAULT_PREFERENCES.timeZone, now);
  const latestSequenceDate = latestSequenceTargetDate(
    tasks,
    planningLocalDate,
  );
  const latestSequenceTime = latestSequenceDate
    ? fromZonedTime(
        `${latestSequenceDate}T${DEFAULT_PREFERENCES.sleepingTime}:00`,
        DEFAULT_PREFERENCES.timeZone,
      ).getTime()
    : Number.NEGATIVE_INFINITY;
  const latestRelevantDate = tasks.reduce((latest, task) => {
    const values = [
      task.dueAt,
      task.fixedStartAt,
      task.recurrence?.windowEnd,
      task.dueDate
        ? fromZonedTime(
            `${task.dueDate}T${DEFAULT_PREFERENCES.sleepingTime}:00`,
            DEFAULT_PREFERENCES.timeZone,
          ).toISOString()
        : undefined,
    ]
      .filter((value): value is string => !!value)
      .map((value) => new Date(value).getTime())
      .filter(Number.isFinite);
    return Math.max(latest, ...values);
  }, Math.max(now.getTime() + 7 * DAY, latestSequenceTime));
  const horizonDays = Math.min(
    120,
    Math.max(8, Math.ceil((latestRelevantDate - now.getTime()) / DAY) + 1),
  );
  const availability = Array.from({ length: horizonDays }, (_, index) => {
    const date = currentLocalDate(
      DEFAULT_PREFERENCES.timeZone,
      new Date(now.getTime() + index * DAY),
    );
    const wakingTime =
      planningRules.earliestWorkTime ?? DEFAULT_PREFERENCES.wakingTime;
    const sleepingTime =
      planningRules.latestWorkTime ?? DEFAULT_PREFERENCES.sleepingTime;
    const sleepingDate =
      sleepingTime <= wakingTime
        ? format(addDays(parseISO(date), 1), "yyyy-MM-dd")
        : date;
    const waking = fromZonedTime(
      `${date}T${wakingTime}:00`,
      DEFAULT_PREFERENCES.timeZone,
    );
    const sleeping = fromZonedTime(
      `${sleepingDate}T${sleepingTime}:00`,
      DEFAULT_PREFERENCES.timeZone,
    );
    const start = new Date(Math.max(now.getTime(), waking.getTime()));
    return start < sleeping
      ? { start: start.toISOString(), end: sleeping.toISOString() }
      : undefined;
  }).filter((interval): interval is { start: string; end: string } => !!interval);
  const windowEnd =
    availability.at(-1)?.end ?? new Date(now.getTime() + 7 * DAY).toISOString();

  return {
    windowStart: now.toISOString(),
    windowEnd,
    allowExplicitTimesOutsideAvailability: true,
    availability,
    unavailableEvents: [],
    blockedTimes: [
      ...protectedBreaks.map(({ start, end }) => ({ start, end })),
      ...(planningRules.blockedTimes ?? []).map(({ start, end }) => ({
        start,
        end,
      })),
    ],
    lockedSessions,
    preferences: {
      ...DEFAULT_PREFERENCES,
      wakingTime:
        planningRules.earliestWorkTime ?? DEFAULT_PREFERENCES.wakingTime,
      sleepingTime:
        planningRules.latestWorkTime ?? DEFAULT_PREFERENCES.sleepingTime,
      planningMode,
    },
  };
}

function scheduleFor(
  tasks: ExtractedTask[],
  planningMode: PlanningMode,
  preservedSessions: PlannedSession[] = [],
  preservedBreaks: ScheduledBreak[] = [],
  planningRules: PlanningRules = {},
): ScheduleProposal {
  const proposal = generateSchedule({
    ...schedulingBase(
      planningMode,
      tasks,
      preservedSessions.map(asExisting),
      preservedBreaks,
      planningRules,
    ),
    tasks: tasks.filter((task) => !task.completed && !task.cancelled),
  });
  const preservedById = new Map(
    preservedSessions.map((session) => [session.id, session]),
  );
  proposal.sessions = proposal.sessions.map(
    (session) => preservedById.get(session.id) ?? session,
  );
  proposal.breaks = [...preservedBreaks, ...proposal.breaks].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );
  return proposal;
}

function asExisting(session: PlannedSession): ExistingSession {
  return {
    id: session.id,
    taskId: session.taskId,
    title: session.title,
    start: session.start,
    end: session.end,
    locked: session.locked,
    status:
      session.status === "in_progress" ? "approved" : session.status,
  };
}

function totalTaskMinutes(task: ExtractedTask): number {
  if (task.recurrence?.mode === "fixed_times") return Number.POSITIVE_INFINITY;
  const occurrences = task.recurrence?.count ?? 1;
  return Math.max(0, (task.estimatedMinutes ?? 0) * occurrences);
}

function nowLabel(): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

export function extractionModeImportSummary(
  mode: ExtractionMode | undefined,
): string {
  switch (mode) {
    case "gemini-hybrid":
      return "Gemini interpreted task meaning and relationships; local source checks verified dates, times, and exact text against the original.";
    case "openai-hybrid":
      return "OpenAI interpreted task meaning and relationships; local source checks verified dates, times, and exact text against the original.";
    case "local-fallback":
      return "AI interpretation was unavailable, so PlanPilot used local parsing. Review uncertain task types, dates, times, and relationships before scheduling.";
    case "gemini":
      return "Gemini interpreted the responsibilities; source text remains available for review.";
    case "openai":
      return "OpenAI interpreted the responsibilities; source text remains available for review.";
    case "fast-local":
      return "Fast local interpretation avoided a network wait; source text and uncertain fields remain available for review.";
    case "local":
    default:
      return "Local interpretation completed; source text and uncertain fields remain available for review.";
  }
}

export function PlanPilotProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<ExtractedTask[]>([]);
  const [lastImportedTaskIds, setLastImportedTaskIds] = useState<string[]>([]);
  const [planningMode, setPlanningModeState] =
    useState<PlanningMode>("balanced");
  const [planningRules, setPlanningRules] = useState<PlanningRules>({});
  const [proposal, setProposal] = useState<ScheduleProposal>(() =>
    scheduleFor([], "balanced"),
  );
  const [importText, setImportText] = useState("");
  const [importDocumentSource, setImportDocumentSource] = useState<DocumentReference>();
  const [importState, setImportState] = useState<ImportState>("idle");
  const [extractionMode, setExtractionMode] = useState<ExtractionMode>();
  const [extractionReport, setExtractionReport] =
    useState<ExtractionPipelineReport>();
  const [importError, setImportError] = useState<string>();
  const [interpretationTrace, setInterpretationTrace] =
    useState<InterpretationTrace>();
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [exportState, setExportState] =
    useState<PlanPilotContextValue["exportState"]>("idle");
  const [replan, setReplan] = useState<ReplanProposal>();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [sessionReviews, setSessionReviews] = useState<SessionReview[]>([]);
  const [scheduleUndoStack, setScheduleUndoStack] = useState<
    PlanningUndoSnapshot[]
  >([]);
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "dark" as Theme);
  const [toast, setToast] = useState<string>();
  const [workspaceStatus, setWorkspaceStatus] =
    useState<WorkspaceStatus>("loading");
  const workspaceSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const current = Date.now();
    const nextBoundary = proposal.sessions
      .flatMap((session) => [session.start, session.end, session.reviewAfter])
      .filter((value): value is string => !!value)
      .map((value) => new Date(value).getTime())
      .filter((value) => Number.isFinite(value) && value > current)
      .sort((a, b) => a - b)[0];
    const delay = nextBoundary
      ? Math.max(50, Math.min(30_000, nextBoundary - current + 25))
      : 30_000;
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [now, proposal.sessions]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/workspace", { cache: "no-store" });
        const body = (await response.json()) as { state?: unknown };
        if (!response.ok) throw new Error("Workspace could not be loaded.");
        if (active && body.state) {
          const saved = parsePersistedWorkspace(body.state);
          setTasks(saved.tasks);
          setPlanningRules(saved.planningRules ?? {});
          const preservedSessions = saved.proposal.sessions.filter(
            (session) => session.locked || session.status !== "proposed",
          );
          const preservedSessionIds = new Set(
            preservedSessions.map((session) => session.id),
          );
          const preservedBreaks = saved.proposal.breaks.filter((item) =>
            preservedSessionIds.has(item.afterSessionId),
          );
          setProposal(
            saved.schedulerVersion === CURRENT_SCHEDULER_VERSION
              ? saved.proposal
              : scheduleFor(
                  saved.tasks,
                  saved.planningMode,
                  preservedSessions,
                  preservedBreaks,
                  saved.planningRules,
                ),
          );
          setImportText(saved.importText);
          setHistory(saved.history);
          setSessionReviews(saved.sessionReviews);
          setPlanningModeState(saved.planningMode);
          setExtractionMode(saved.extractionMode);
          setReplan(saved.replan);
        }
        if (active) setWorkspaceStatus("ready");
      } catch {
        if (active) {
          setWorkspaceStatus("error");
          setToast("Workspace storage is unavailable. Changes may not survive a refresh.");
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (workspaceStatus !== "ready") return;
    const timer = window.setTimeout(() => {
      const body = JSON.stringify({
        state: {
          version: 1,
          schedulerVersion: CURRENT_SCHEDULER_VERSION,
          tasks,
          proposal,
          importText,
          history,
          sessionReviews,
          planningMode,
          planningRules,
          extractionMode,
          replan,
        },
      });
      workspaceSaveQueueRef.current = workspaceSaveQueueRef.current
        .catch(() => undefined)
        .then(async () => {
          const response = await fetch("/api/workspace", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body,
          });
          if (!response.ok) {
            throw new Error("Workspace save failed.");
          }
        })
        .catch(() => {
          setToast("A recent change could not be saved. Please try again.");
        });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [
    workspaceStatus,
    tasks,
    proposal,
    importText,
    history,
    sessionReviews,
    planningMode,
    planningRules,
    extractionMode,
    replan,
  ]);

  const reviewQueue = useMemo(
    () => sessionCheckIns(proposal.sessions, now),
    [now, proposal.sessions],
  );

  const rememberScheduleChange = useCallback(
    (label: string) => {
      const snapshot: PlanningUndoSnapshot = {
        label,
        tasks,
        proposal,
        planningMode,
        planningRules,
        replan,
        selectedSessionIds,
        sessionReviews,
        lastImportedTaskIds,
      };
      setScheduleUndoStack((stack) => pushPlanningUndo(stack, snapshot));
    },
    [
      planningMode,
      planningRules,
      proposal,
      replan,
      selectedSessionIds,
      sessionReviews,
      lastImportedTaskIds,
      tasks,
    ],
  );

  const undoSchedule = useCallback(() => {
    const { snapshot, remaining } = popPlanningUndo(scheduleUndoStack);
    if (!snapshot) {
      setToast("There are no schedule changes to undo.");
      return;
    }
    setTasks(snapshot.tasks);
    setProposal(snapshot.proposal);
    setPlanningModeState(snapshot.planningMode);
    setPlanningRules(snapshot.planningRules);
    setReplan(snapshot.replan);
    setSelectedSessionIds(snapshot.selectedSessionIds);
    setSessionReviews(snapshot.sessionReviews);
    setLastImportedTaskIds(snapshot.lastImportedTaskIds);
    setScheduleUndoStack(remaining);
    setHistory((items) => [
      {
        id: `history-undo-${Date.now()}`,
        at: nowLabel(),
        icon: "move",
        title: `Undid ${snapshot.label}`,
        detail: "Restored the responsibilities and schedule to their previous state.",
      },
      ...items,
    ]);
    setToast(`Undid ${snapshot.label}.`);
  }, [scheduleUndoStack]);

  const refresh = useCallback(
    (nextTasks: ExtractedTask[], nextMode = planningMode) => {
      setProposal(scheduleFor(nextTasks, nextMode, [], [], planningRules));
      setReplan(undefined);
    },
    [planningMode, planningRules],
  );

  const analyzeText = useCallback(async (instructions?: { globalInstructions?: string; allowInlineGlobalInstructions?: boolean }) => {
    setImportState("loading");
    setExtractionMode(undefined);
    setExtractionReport(undefined);
    setImportError(undefined);
    setInterpretationTrace(undefined);
    try {
      const response = await fetch("/api/extract", {
        method: "POST",
        // The semantic provider has a 45-second repair/retry budget. Keep the
        // browser alive long enough to receive that safe result plus server
        // compilation and network overhead.
        signal: AbortSignal.timeout(60_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: importText,
          globalInstructions: instructions?.globalInstructions,
          allowInlineGlobalInstructions: instructions?.allowInlineGlobalInstructions ?? false,
          currentLocalDate: currentLocalDate(DEFAULT_PREFERENCES.timeZone),
          timeZone: DEFAULT_PREFERENCES.timeZone,
        }),
      });
      const body = (await response.json()) as {
        tasks?: ExtractedTask[];
        planningRules?: PlanningRules;
        interpretation?: InterpretationTrace;
        extractionMode?: ExtractionMode;
        extractionReport?: ExtractionPipelineReport;
        error?: { message: string; reason?: ExtractionFallbackReason };
      };
      if (!response.ok || !body.tasks) {
        const providerMessage = body.error?.message ?? "Extraction failed.";
        throw new Error(
          extractionFailureMessage(body.error?.reason, providerMessage),
        );
      }
      const extractedTasks = importDocumentSource
        ? body.tasks.map((task) => attachDocumentSource(task, importDocumentSource))
        : body.tasks;
      const nextPlanningRules = mergeImportedPlanningRules(
        planningRules,
        body.planningRules,
        DEFAULT_PREFERENCES.timeZone,
      );
      const merged = mergeImportedTasks(tasks, extractedTasks);
      merged.tasks = recalculateLinkedTiming(merged.tasks, DEFAULT_PREFERENCES.timeZone);
      const retainedTaskIds = new Set(
        merged.tasks
          .map((task) => task.id)
          .filter((id): id is string => !!id),
      );
      const refreshedTaskIds = new Set(merged.refreshedTaskIds);
      const preservedSessions = sessionsToPreserveAfterImport(
        proposal.sessions,
        retainedTaskIds,
        refreshedTaskIds,
      );
      const preservedSessionIds = new Set(
        preservedSessions.map((session) => session.id),
      );
      const preservedBreaks = proposal.breaks.filter((item) =>
        preservedSessionIds.has(item.afterSessionId),
      );
      if (
        merged.addedTasks.length > 0 ||
        merged.removedMetadataCount > 0 ||
        merged.refreshedTaskCount > 0
      ) {
        rememberScheduleChange("responsibility import");
      }
      setTasks(merged.tasks);
      setPlanningRules(nextPlanningRules);
      setLastImportedTaskIds(merged.importedTaskIds);
      setExtractionMode(body.extractionMode);
      setExtractionReport(body.extractionReport);
      setInterpretationTrace(body.interpretation);
      setProposal(
        scheduleFor(
          merged.tasks,
          planningMode,
          preservedSessions,
          preservedBreaks,
          nextPlanningRules,
        ),
      );
      setReplan(undefined);
      setImportState("success");
      setHistory((items) => [
        {
          id: `history-import-${Date.now()}`,
          at: nowLabel(),
          icon: "edit",
          title: `${merged.addedTasks.length} responsibilities added`,
          detail: `${extractionModeImportSummary(body.extractionMode)}${merged.duplicateCount > 0 ? ` ${merged.duplicateCount} already-added responsibilities were reused.` : ""}${merged.removedMetadataCount > 0 ? ` ${merged.removedMetadataCount} non-task portal rows were removed.` : ""}${merged.refreshedTaskCount > 0 ? ` ${merged.refreshedTaskCount} earlier interpretations were corrected.` : ""}`,
        },
        ...items,
      ]);
      const fallbackNotice = extractionFallbackNotice(body.extractionReport);
      const ordinarySuccessToast =
        merged.removedMetadataCount > 0 && merged.refreshedTaskCount > 0
          ? `Cleaned up ${merged.removedMetadataCount} non-task portal rows and corrected ${merged.refreshedTaskCount} earlier interpretations.`
          : merged.refreshedTaskCount > 0
            ? `Corrected ${merged.refreshedTaskCount} earlier ${merged.refreshedTaskCount === 1 ? "interpretation" : "interpretations"}.`
            : merged.removedMetadataCount > 0
              ? `Cleaned up ${merged.removedMetadataCount} non-task portal ${merged.removedMetadataCount === 1 ? "row" : "rows"}.`
          : merged.addedTasks.length > 0
          ? `${merged.addedTasks.length} responsibilities added. Existing commitments were preserved.`
          : "Those responsibilities are already in your plan.";
      setToast(
        fallbackNotice
          ? `Local fallback used: ${fallbackNotice.title}. ${fallbackNotice.action}`
          : ordinarySuccessToast,
      );
    } catch (error) {
      setImportState("error");
      setImportError(
        error instanceof DOMException &&
          ["AbortError", "TimeoutError"].includes(error.name)
          ? "Interpretation took too long. Your text is still here—please retry."
          : error instanceof Error
          ? error.message
          : "Extraction failed. Your text is still here to retry.",
      );
    }
  }, [importDocumentSource, importText, planningMode, planningRules, proposal, rememberScheduleChange, tasks]);

  const updateTask = useCallback(
    (
      id: string,
      patch: Partial<ExtractedTask>,
      undoLabel = "task edit",
    ) => {
      if (!tasks.some((task) => task.id === id)) return;
      rememberScheduleChange(undoLabel);
      setTasks((current) => {
        const workflowOnlyFields = new Set([
          "id",
          "sourceText",
          "sourceSpan",
          "fieldProvenance",
          "dependencies",
          "missingInformation",
          "approved",
          "reviewRequired",
          "completed",
          "completedAt",
          "completedMinutes",
          "cancelled",
          "cancelledAt",
        ]);
        const editedPaths = Object.keys(patch).filter(
          (path) => !workflowOnlyFields.has(path),
        );
        const original = current.find((task) => task.id === id)!;
        const next = applyLinkedTaskEdit(current, id, {
          ...patch,
          fieldProvenance: patch.fieldProvenance ?? withUserFieldProvenance(original, editedPaths),
        }, DEFAULT_PREFERENCES.timeZone);
        refresh(next);
        return next;
      });
    },
    [refresh, rememberScheduleChange, tasks],
  );

  const setSequenceStartDate = useCallback(
    (groupId: string, date?: string) => {
      const sequenceTasks = tasks.filter(
        (task) => taskSequence(task)?.groupId === groupId,
      );
      if (sequenceTasks.length === 0) {
        setToast("That learning plan is no longer available.");
        return;
      }

      const anchorDate = date?.trim() || undefined;
      if (
        anchorDate &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate) ||
          Number.isNaN(parseISO(anchorDate).getTime()) ||
          format(parseISO(anchorDate), "yyyy-MM-dd") !== anchorDate)
      ) {
        setToast("Choose a valid plan start date.");
        return;
      }

      const nextTasks = tasks.map((task) => {
        const sequence = taskSequence(task);
        if (sequence?.groupId !== groupId) return task;

        const missingInformation = anchorDate
          ? task.missingInformation.filter(
              (item) => !isPlanStartDateRequirement(item),
            )
          : [
              ...task.missingInformation.filter(
                (item) => !isPlanStartDateRequirement(item),
              ),
              PLAN_START_DATE_REQUIREMENT,
            ];
        const reviewRequired = !anchorDate || missingInformation.length > 0;

        return {
          ...task,
          sequence: {
            ...sequence,
            anchorDate,
          },
          missingInformation,
          reviewRequired,
          approved: !reviewRequired,
          fieldProvenance: withUserFieldProvenance(task, [
            "sequence.anchorDate",
          ]),
        };
      });
      const hasChanged = sequenceTasks.some((task) => {
        const sequence = taskSequence(task);
        const hasStartDateRequirement = task.missingInformation.some(
          isPlanStartDateRequirement,
        );
        const expectedReviewRequired =
          !anchorDate ||
          task.missingInformation.some(
            (item) => !isPlanStartDateRequirement(item),
          );
        return (
          sequence?.anchorDate !== anchorDate ||
          hasStartDateRequirement === Boolean(anchorDate) ||
          task.reviewRequired !== expectedReviewRequired ||
          task.approved === expectedReviewRequired
        );
      });
      if (!hasChanged) return;

      const affectedTaskIds = new Set(
        sequenceTasks.map((task) => task.id ?? task.title),
      );
      const currentTime = Date.now();
      const completedStatuses = new Set([
        "completed",
        "partial",
        "missed",
        "unnecessary",
      ]);
      const preservedSessions = proposal.sessions.filter(
        (session) =>
          !affectedTaskIds.has(session.taskId) ||
          completedStatuses.has(session.status) ||
          new Date(session.start).getTime() <= currentTime,
      );
      const preservedSessionIds = new Set(
        preservedSessions.map((session) => session.id),
      );
      const preservedBreaks = proposal.breaks.filter((item) =>
        preservedSessionIds.has(item.afterSessionId),
      );

      rememberScheduleChange("plan start date change");
      const nextProposal = scheduleFor(
        nextTasks,
        planningMode,
        preservedSessions,
        preservedBreaks,
        planningRules,
      );
      const nextSessionIds = new Set(
        nextProposal.sessions.map((session) => session.id),
      );

      setTasks(nextTasks);
      setProposal(nextProposal);
      setSelectedSessionIds((current) =>
        current.filter((id) => nextSessionIds.has(id)),
      );
      setReplan(undefined);
      setHistory((items) => [
        {
          id: `history-sequence-start-${Date.now()}`,
          at: nowLabel(),
          icon: "move",
          title: anchorDate
            ? `Plan starts ${format(parseISO(anchorDate), "MMM d, yyyy")}`
            : "Plan start date cleared",
          detail: anchorDate
            ? `${sequenceTasks.length} responsibilities were aligned to the selected start date.`
            : `${sequenceTasks.length} responsibilities are waiting for a new start date.`,
        },
        ...items,
      ]);
      setToast(
        anchorDate
          ? `Plan moved to start ${format(parseISO(anchorDate), "MMM d")}.`
          : "Plan start date cleared. Choose a new date before approving it.",
      );
    },
    [
      planningMode,
      planningRules,
      proposal,
      rememberScheduleChange,
      tasks,
    ],
  );

  const approveTask = useCallback(
    (id: string) => {
      const task = tasks.find((item) => item.id === id);
      const sequence = task ? taskSequence(task) : undefined;
      if (task?.schedulingConstraints?.linkedTiming?.unresolved) {
        setToast("Confirm or correct the related event before approving this calculated time.");
        return;
      }
      if (sequence && !sequence.anchorDate) {
        setToast("Choose a plan start date before approving this responsibility.");
        return;
      }
      updateTask(
        id,
        {
          approved: true,
          reviewRequired: false,
          missingInformation: [],
        },
        "task approval",
      );
      setToast("Task approved and included in the next proposal.");
    },
    [tasks, updateTask],
  );

  const deleteTasks = useCallback(
    (ids: string[]) => {
      const requestedIds = new Set(ids);
      const removedTasks = tasks.filter(
        (task) => task.id && requestedIds.has(task.id),
      );
      if (removedTasks.length === 0) return;

      rememberScheduleChange(
        removedTasks.length === 1 ? "task deletion" : "task group deletion",
      );
      const removedIds = new Set(
        removedTasks
          .map((task) => task.id)
          .filter((id): id is string => !!id),
      );
      const nextTasks = recalculateLinkedTiming(tasks.filter(
        (task) => !task.id || !removedIds.has(task.id),
      ), DEFAULT_PREFERENCES.timeZone);
      const nextPlanningRules = nextTasks.length === 0 ? {} : planningRules;
      const retainedTaskIds = new Set(
        nextTasks
          .map((task) => task.id)
          .filter((id): id is string => !!id),
      );
      const preservedSessions = proposal.sessions.filter((session) =>
        retainedTaskIds.has(session.taskId) && !nextTasks.find((task) => task.id === session.taskId)?.reviewRequired,
      );
      const preservedSessionIds = new Set(
        preservedSessions.map((session) => session.id),
      );

      setTasks(nextTasks);
      setPlanningRules(nextPlanningRules);
      setLastImportedTaskIds((current) =>
        current.filter((id) => !removedIds.has(id)),
      );
      setProposal(
        scheduleFor(
          nextTasks,
          planningMode,
          preservedSessions,
          proposal.breaks.filter((item) =>
            preservedSessionIds.has(item.afterSessionId),
          ),
          nextPlanningRules,
        ),
      );
      setSelectedSessionIds((current) =>
        current.filter((id) => preservedSessionIds.has(id)),
      );
      setSessionReviews((current) =>
        current.filter((review) => preservedSessionIds.has(review.sessionId)),
      );
      setReplan(undefined);
      setToast(
        removedTasks.length === 1
          ? "Task removed. You can undo this from Schedule."
          : `${removedTasks.length} tasks removed. You can undo this from Schedule.`,
      );
    },
    [planningMode, planningRules, proposal, rememberScheduleChange, tasks],
  );

  const deleteTask = useCallback(
    (id: string) => deleteTasks([id]),
    [deleteTasks],
  );

  const approveSession = useCallback((id: string) => {
    if (
      !proposal.sessions.some(
        (session) => session.id === id && session.status === "proposed",
      )
    ) {
      return;
    }
    rememberScheduleChange("session approval");
    const taskId = proposal.sessions.find((session) => session.id === id)?.taskId;
    setTasks((current) => current.map((task) => task.id === taskId && task.schedulingConstraints?.calculatedTiming
      ? { ...task, approved: true, reviewRequired: false, missingInformation: [] } : task));
    setProposal((current) => ({
      ...current,
      sessions: current.sessions.map((session) =>
        session.id === id && session.status === "proposed"
          ? { ...session, status: "approved" }
          : session,
      ),
    }));
    setToast("Session approved. It will enter Daily Review after it ends.");
  }, [proposal.sessions, rememberScheduleChange]);

  const approveAllSessions = useCallback(() => {
    if (!proposal.sessions.some((session) => session.status === "proposed")) {
      return;
    }
    rememberScheduleChange("complete plan approval");
    const approvingTaskIds = new Set(proposal.sessions.filter((session) => session.status === "proposed").map((session) => session.taskId));
    setTasks((current) => current.map((task) => task.id && approvingTaskIds.has(task.id) && task.schedulingConstraints?.calculatedTiming
      ? { ...task, approved: true, reviewRequired: false, missingInformation: [] } : task));
    setProposal((current) => ({
      ...current,
      sessions: current.sessions.map((session) =>
        session.status === "proposed"
          ? { ...session, status: "approved" }
          : session,
      ),
    }));
    setSelectedSessionIds([]);
    setToast("All proposed sessions approved. They will be reviewed after they end.");
  }, [proposal.sessions, rememberScheduleChange]);

  const toggleSessionLock = useCallback((id: string) => {
    if (!proposal.sessions.some((session) => session.id === id)) return;
    rememberScheduleChange("session lock change");
    setProposal((current) => ({
      ...current,
      sessions: current.sessions.map((session) =>
        session.id === id ? { ...session, locked: !session.locked } : session,
      ),
    }));
  }, [proposal.sessions, rememberScheduleChange]);

  const rejectSession = useCallback((id: string) => {
    if (!proposal.sessions.some((session) => session.id === id)) return;
    rememberScheduleChange("session rejection");
    setProposal((current) => ({
      ...current,
      sessions: current.sessions.filter((session) => session.id !== id),
    }));
    setToast("Session rejected. The task remains unscheduled.");
  }, [proposal.sessions, rememberScheduleChange]);

  const requestAnotherTime = useCallback(
    (id: string) => {
      const target = proposal.sessions.find((session) => session.id === id);
      if (!target || target.locked) {
        setToast("Locked sessions must be unlocked before they can move.");
        return;
      }
      const base = schedulingBase(planningMode, tasks, [], [], planningRules);
      const increment = 15 * MINUTE;
      const duration =
        new Date(target.end).getTime() - new Date(target.start).getTime();
      let start = new Date(target.start).getTime() + increment;
      const task = tasks.find((item) => item.id === target.taskId);
      const deadlineValue = task?.dueAt ?? task?.recurrence?.windowEnd;
      const deadlineAt = deadlineValue
        ? new Date(deadlineValue).getTime()
        : new Date(base.windowEnd).getTime();
      for (let attempt = 0; attempt < 7 * 24 * 4; attempt += 1) {
        const end = start + duration;
        const insideAvailability = base.availability.some(
          (interval) =>
            start >= new Date(interval.start).getTime() &&
            end <= new Date(interval.end).getTime(),
        );
        const overlaps = proposal.sessions.some(
          (session) =>
            session.id !== id &&
            start < new Date(session.end).getTime() &&
            new Date(session.start).getTime() < end,
        );
        const overlapsProtectedTime = base.blockedTimes.some(
          (interval) =>
            start < new Date(interval.end).getTime() &&
            new Date(interval.start).getTime() < end,
        );
        if (
          insideAvailability &&
          !overlaps &&
          !overlapsProtectedTime &&
          sessionFitsTaskHours(task, start, end) &&
          end <= deadlineAt
        ) {
          rememberScheduleChange("session move");
          setProposal({
            ...proposal,
            sessions: proposal.sessions
              .map((session) =>
                session.id === id
                  ? {
                      ...session,
                      start: new Date(start).toISOString(),
                      end: new Date(end).toISOString(),
                      reviewAfter: undefined,
                      explanation:
                        "Moved to another valid opening at your request. The deadline and existing sessions remain protected.",
                    }
                  : session,
              )
              .sort(
                (a, b) =>
                  new Date(a.start).getTime() - new Date(b.start).getTime(),
              ),
          });
          setToast("Moved to the next valid opening.");
          return;
        }
        start += increment;
      }
      setToast("No other valid opening fits before the deadline. Nothing moved.");
    },
    [planningMode, planningRules, proposal, rememberScheduleChange, tasks],
  );

  const placeSessionManually = useCallback(
    (
      id: string,
      start: string,
      deadlineUpdate?: ManualDeadlineUpdate,
    ) => {
      const target = proposal.sessions.find((session) => session.id === id);
      const task = target
        ? tasks.find((item) => item.id === target.taskId)
        : undefined;
      if (!target || !task) {
        setToast("That scheduled task is no longer available.");
        return;
      }
      if (
        task.taskType === "fixed_time" ||
        task.recurrence?.mode === "fixed_times"
      ) {
        setToast("Fixed commitments must be edited from the task details.");
        return;
      }
      try {
        let moved = manuallyPlacedSession(target, start);
        const nextTasks = deadlineUpdate
          ? tasks.map((item) =>
              item.id === task.id
                ? {
                    ...item,
                    ...deadlineUpdateFields(
                      deadlineUpdate,
                      DEFAULT_PREFERENCES.timeZone,
                    ),
                    dueWindow: undefined,
                    fieldConfidence: {
                      ...item.fieldConfidence,
                      dueDate: 1,
                      dueTime: deadlineUpdate.dueTime ? 1 : undefined,
                    },
                  }
                : item,
            )
          : tasks;
        const effectiveTask = nextTasks.find((item) => item.id === task.id);
        const endsAfterDeadline = isManualPlacementAfterDeadline(
          effectiveTask,
          moved.end,
          DEFAULT_PREFERENCES.timeZone,
          planningRules.latestWorkTime ?? DEFAULT_PREFERENCES.sleepingTime,
        );
        if (deadlineUpdate && endsAfterDeadline) {
          throw new Error("The new deadline must be at or after this session ends.");
        }
        if (endsAfterDeadline) {
          moved = {
            ...moved,
            reasonCodes: ["USER_PLACEMENT", "OVERDUE_RECOVERY"],
            explanation:
              "Locked at the date and time you chose. It ends after the current deadline, and flexible work will be scheduled around your decision.",
          };
        }
        const previousTargetBreak = proposal.breaks.find(
          (item) => item.afterSessionId === id,
        );
        const movedBreak = manuallyPlacedBreak(
          moved,
          previousTargetBreak,
          task.energyDemand === "high"
            ? DEFAULT_PREFERENCES.preferredBreakMinutes
            : 0,
        );
        const protectedUntil = movedBreak?.end ?? moved.end;
        const preservedSessions = sessionsForManualPlacementReflow(
          proposal.sessions,
          nextTasks,
          moved,
          protectedUntil,
        );
        const preservedIds = new Set(
          preservedSessions.map((session) => session.id),
        );
        const preservedBreaks = proposal.breaks.filter(
          (item) =>
            item.afterSessionId !== id &&
            preservedIds.has(item.afterSessionId) &&
            !intervalOverlapsManualPlacement(
              item.start,
              item.end,
              moved,
              protectedUntil,
            ),
        );
        if (movedBreak) preservedBreaks.push(movedBreak);
        const nextProposal = scheduleFor(
          nextTasks,
          planningMode,
          preservedSessions,
          preservedBreaks,
          planningRules,
        );

        rememberScheduleChange("manual session placement");
        setTasks(nextTasks);
        setProposal(nextProposal);
        setReplan(undefined);
        setHistory((items) => [
          {
            id: `history-manual-move-${Date.now()}`,
            at: nowLabel(),
            icon: "move",
            title: `${target.title} placed manually`,
            detail: deadlineUpdate
              ? "Your chosen time was locked and the deadline was updated. Flexible work was replanned around it."
              : "Your chosen time was locked. Flexible work was replanned around it.",
          },
          ...items,
        ]);
        setToast(
          deadlineUpdate
            ? "Time locked and deadline updated. Flexible work moved around your choice."
            : "Time locked. Flexible work moved around your choice.",
        );
      } catch (error) {
        setToast(
          error instanceof Error
            ? error.message
            : "That placement could not be saved.",
        );
      }
    },
    [
      planningMode,
      planningRules,
      proposal,
      rememberScheduleChange,
      tasks,
    ],
  );

  const toggleSelectedSession = useCallback((id: string) => {
    setSelectedSessionIds((ids) =>
      ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id],
    );
  }, []);

  const exportApprovedSessions = useCallback(async () => {
    const approved = proposal.sessions.filter(
      (session) => session.status === "approved",
    );
    if (approved.length === 0) {
      setToast("Approve at least one session before exporting.");
      return;
    }
    setExportState("loading");
    try {
      const response = await fetch("/api/calendar/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          explicitlyApproved: true,
          reminderMinutes: 10,
          sessions: approved,
        }),
      });
      if (!response.ok) {
        const result: unknown = await response.json().catch(() => null);
        const message =
          typeof result === "object" && result !== null &&
          "error" in result && typeof result.error === "object" && result.error !== null &&
          "message" in result.error && typeof result.error.message === "string"
            ? result.error.message
            : "Calendar export failed.";
        throw new Error(message);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "planpilot-schedule.ics";
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
        // Allow the browser to start reading the download before releasing it.
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      setExportState("success");
      setToast(`Calendar file ready: ${approved.length} approved sessions. Import it in Google Calendar → Settings → Import & export.`);
      setHistory((items) => [
        {
          id: `history-calendar-${Date.now()}`,
          at: nowLabel(),
          icon: "calendar",
          title: `${approved.length} sessions exported to calendar file`,
          detail: "Downloaded planpilot-schedule.ics for manual import into Google Calendar. This does not sync future changes.",
        },
        ...items,
      ]);
    } catch (error) {
      setExportState("error");
      setToast(`${error instanceof Error ? error.message : "Calendar export failed."} Your approved plan is unchanged.`);
    }
  }, [proposal.sessions]);

  const reviewSession = useCallback(
    (
      sessionId: string,
      outcome: SessionOutcome,
      minutesCompleted?: number,
    ) => {
      const checkIn = reviewQueue.find((item) => item.session.id === sessionId);
      const session = checkIn?.session;
      if (!session || !checkIn) {
        setToast("That session is not ready for a check-in.");
        return;
      }
      if (!canRecordSessionOutcome(checkIn, outcome)) {
        setToast("A session can only be marked missed after its scheduled end time.");
        return;
      }
      const task = tasks.find((item) => item.id === session.taskId);
      const plannedMinutes = session.minutes;
      const reviewedAt = new Date().toISOString();
      let review: SessionReview;
      try {
        review = createSessionReview(
          session,
          outcome,
          reviewedAt,
          minutesCompleted,
        );
      } catch (error) {
        setToast(
          error instanceof Error
            ? error.message
            : `Enter between 1 and ${plannedMinutes - 1} completed minutes.`,
        );
        return;
      }
      const { completedMinutes, remainingMinutes } = review;
      rememberScheduleChange("session outcome");
      setSessionReviews((items) => [review, ...items]);

      const taskFinished = !!task &&
        totalTaskMinutes(task) > 0 &&
        (task.completedMinutes ?? 0) + completedMinutes >= totalTaskMinutes(task);
      setTasks((current) =>
        current.map((item) => {
          if (item.id !== session.taskId) return item;
          if (outcome === "unnecessary") {
            return { ...item, cancelled: true, cancelledAt: reviewedAt };
          }
          const nextCompleted =
            (item.completedMinutes ?? 0) + completedMinutes;
          return {
            ...item,
            completedMinutes: nextCompleted,
            completed: taskFinished,
            completedAt: taskFinished ? reviewedAt : item.completedAt,
          };
        }),
      );

      const outcomeStatus = outcome;
      setProposal((current) => ({
        ...current,
        sessions: current.sessions
          .map((item) =>
            item.id === session.id
              ? {
                  ...item,
                  status: outcomeStatus,
                  reviewedAt,
                  reviewAfter: undefined,
                  minutesCompleted: completedMinutes,
                }
              : item,
          )
          .filter((item) => {
            if (item.id === session.id || item.taskId !== session.taskId) {
              return true;
            }
            if (outcome === "unnecessary") return false;
            if (taskFinished && new Date(item.start).getTime() > Date.now()) {
              return false;
            }
            return true;
          }),
      }));

      if ((outcome === "partial" || outcome === "missed") && task) {
        const existing = proposal.sessions.map(asExisting);
        setReplan(
          proposeMinimalReplan({
            session: asExisting(session),
            outcome,
            minutesCompleted: completedMinutes,
            sessions: existing,
            task,
            scheduling: schedulingBase(
              planningMode,
              tasks,
              [],
              [],
              planningRules,
            ),
          }),
        );
      } else {
        setReplan(undefined);
      }

      const outcomeLabel =
        outcome === "completed"
          ? "completed"
          : outcome === "partial"
            ? `partially completed (${completedMinutes}/${plannedMinutes} minutes)`
            : outcome === "missed"
              ? "missed"
              : "no longer needed";
      setHistory((items) => [
        {
          id: `history-review-${Date.now()}`,
          at: nowLabel(),
          icon: outcome === "completed" ? "complete" : "move",
          title: `${session.title}: ${outcomeLabel}`,
          detail:
            remainingMinutes > 0
              ? `${remainingMinutes} minutes remain and a minimal recovery option was calculated.`
              : "The session outcome was recorded and the task progress was updated.",
        },
        ...items,
      ]);
      setToast(
        remainingMinutes > 0
          ? "Outcome saved. Review the recovery option below."
          : "Outcome saved.",
      );
    },
    [planningMode, planningRules, proposal.sessions, rememberScheduleChange, reviewQueue, tasks],
  );

  const delaySessionReview = useCallback((sessionId: string) => {
    if (!proposal.sessions.some((session) => session.id === sessionId)) return;
    rememberScheduleChange("session review delay");
    const reviewAfter = new Date(Date.now() + 15 * MINUTE).toISOString();
    setProposal((current) => ({
      ...current,
      sessions: current.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, status: "in_progress", reviewAfter }
          : session,
      ),
    }));
    setToast("Still working noted. PlanPilot will ask again in 15 minutes.");
  }, [proposal.sessions, rememberScheduleChange]);

  const applyReplan = useCallback(() => {
    if (!replan) return;
    if (replan.changes.some((change) => "after" in change)) {
      rememberScheduleChange("recovery change");
    }
    setProposal((current) => {
      let sessions = [...current.sessions];
      for (const change of replan.changes) {
        if ("after" in change) {
          sessions = sessions.filter((session) => session.id !== change.after.id);
          sessions.push(change.after);
        }
      }
      return {
        ...current,
        sessions: sessions.sort(
          (a, b) =>
            new Date(a.start).getTime() - new Date(b.start).getTime(),
        ),
      };
    });
    const changed = replan.changes.find((change) => "after" in change);
    setHistory((items) => [
      {
        id: `history-replan-${Date.now()}`,
        at: nowLabel(),
        icon: "move",
        title: changed && "after" in changed
          ? `${changed.after.title} recovery scheduled`
          : "Recovery could not be scheduled",
        detail: replan.explanation,
      },
      ...items,
    ]);
    setToast(
      changed ? "Recovery session added. Other sessions were preserved." : "Outcome kept; no valid recovery opening was available.",
    );
    setReplan(undefined);
  }, [rememberScheduleChange, replan]);

  const setPlanningMode = useCallback(
    (mode: PlanningMode) => {
      if (mode === planningMode) return;
      rememberScheduleChange("planning mode change");
      setPlanningModeState(mode);
      refresh(tasks, mode);
      setToast(`${mode[0].toUpperCase()}${mode.slice(1)} planning rules applied.`);
    },
    [planningMode, refresh, rememberScheduleChange, tasks],
  );

  const toggleTheme = useCallback(() => {
    writeTheme(readTheme() === "light" ? "dark" : "light");
  }, []);
  useEffect(() => {
    // Keep the <html> class in sync with the stored preference on first load.
    document.documentElement.classList.toggle("dark", readTheme() === "dark");
  }, []);

  const clearWorkspace = useCallback(() => {
    setTasks([]);
    setLastImportedTaskIds([]);
    setPlanningRules({});
    setProposal(scheduleFor([], planningMode));
    setImportText("");
    setImportDocumentSource(undefined);
    setImportState("idle");
    setExtractionMode(undefined);
    setExtractionReport(undefined);
    setImportError(undefined);
    setInterpretationTrace(undefined);
    setSelectedSessionIds([]);
    setExportState("idle");
    setReplan(undefined);
    setHistory([]);
    setSessionReviews([]);
    setScheduleUndoStack([]);
    workspaceSaveQueueRef.current = workspaceSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const response = await fetch("/api/workspace", { method: "DELETE" });
        if (!response.ok) throw new Error("Workspace clear failed.");
      })
      .catch(() => {
        setToast("The workspace was cleared here but could not be cleared from storage.");
      });
    setToast("Workspace cleared. Planning mode and theme were kept.");
  }, [planningMode]);

  const value = useMemo<PlanPilotContextValue>(
    () => ({
      tasks,
      lastImportedTaskIds,
      proposal,
      importText,
      setImportText,
      setImportDocumentSource,
      importState,
      extractionMode,
      extractionReport,
      importError,
      interpretationTrace,
      analyzeText,
      updateTask,
      setSequenceStartDate,
      approveTask,
      deleteTask,
      deleteTasks,
      approveSession,
      approveAllSessions,
      toggleSessionLock,
      rejectSession,
      requestAnotherTime,
      placeSessionManually,
      selectedSessionIds,
      toggleSelectedSession,
      exportApprovedSessions,
      exportState,
      replan,
      applyReplan,
      reviewQueue,
      sessionReviews,
      reviewSession,
      delaySessionReview,
      history,
      planningMode,
      planningRules,
      setPlanningMode,
      canUndoSchedule: scheduleUndoStack.length > 0,
      undoScheduleLabel: scheduleUndoStack.at(-1)?.label,
      undoSchedule,
      theme,
      toggleTheme,
      clearWorkspace,
      workspaceStatus,
      toast,
      clearToast: () => setToast(undefined),
    }),
    [
      tasks,
      lastImportedTaskIds,
      proposal,
      importText,
      setImportDocumentSource,
      importState,
      extractionMode,
      extractionReport,
      importError,
      interpretationTrace,
      analyzeText,
      updateTask,
      setSequenceStartDate,
      approveTask,
      deleteTask,
      deleteTasks,
      approveSession,
      approveAllSessions,
      toggleSessionLock,
      rejectSession,
      requestAnotherTime,
      placeSessionManually,
      selectedSessionIds,
      toggleSelectedSession,
      exportApprovedSessions,
      exportState,
      replan,
      applyReplan,
      reviewQueue,
      sessionReviews,
      reviewSession,
      delaySessionReview,
      history,
      planningMode,
      planningRules,
      setPlanningMode,
      scheduleUndoStack,
      undoSchedule,
      theme,
      toggleTheme,
      clearWorkspace,
      workspaceStatus,
      toast,
    ],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePlanPilot(): PlanPilotContextValue {
  const value = useContext(Context);
  if (!value) throw new Error("usePlanPilot requires PlanPilotProvider.");
  return value;
}
