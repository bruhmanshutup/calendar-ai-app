"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { fromZonedTime } from "date-fns-tz";
import { DEFAULT_PREFERENCES } from "@/lib/defaults";
import { generateSchedule } from "@/lib/domain/scheduler";
import { mergeImportedTasks } from "@/lib/domain/task-import";
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
import { parsePersistedWorkspace } from "@/lib/domain/workspace-state";
import type {
  ExistingSession,
  ExtractedTask,
  HistoryItem,
  PlannedSession,
  PlanningMode,
  ReplanProposal,
  ScheduleProposal,
  ScheduledBreak,
  SchedulingInput,
  SessionOutcome,
  SessionReview,
} from "@/lib/domain/types";

type ImportState = "idle" | "loading" | "success" | "error";
type ExtractionMode = "gemini" | "openai" | "local";
type WorkspaceStatus = "loading" | "ready" | "error";

type PlanPilotContextValue = {
  tasks: ExtractedTask[];
  lastImportedTaskIds: string[];
  proposal: ScheduleProposal;
  importText: string;
  setImportText: (text: string) => void;
  importState: ImportState;
  extractionMode?: ExtractionMode;
  importError?: string;
  analyzeText: () => Promise<void>;
  updateTask: (id: string, patch: Partial<ExtractedTask>) => void;
  approveTask: (id: string) => void;
  deleteTask: (id: string) => void;
  approveSession: (id: string) => void;
  approveAllSessions: () => void;
  toggleSessionLock: (id: string) => void;
  rejectSession: (id: string) => void;
  requestAnotherTime: (id: string) => void;
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
const CURRENT_SCHEDULER_VERSION = 7;

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

function schedulingBase(
  planningMode: PlanningMode,
  tasks: ExtractedTask[] = [],
  lockedSessions: ExistingSession[] = [],
  protectedBreaks: ScheduledBreak[] = [],
): Omit<SchedulingInput, "tasks"> {
  const now = new Date(Math.ceil(Date.now() / (15 * MINUTE)) * 15 * MINUTE);
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
  }, now.getTime() + 7 * DAY);
  const horizonDays = Math.min(
    35,
    Math.max(8, Math.ceil((latestRelevantDate - now.getTime()) / DAY) + 1),
  );
  const availability = Array.from({ length: horizonDays }, (_, index) => {
    const date = currentLocalDate(
      DEFAULT_PREFERENCES.timeZone,
      new Date(now.getTime() + index * DAY),
    );
    const waking = fromZonedTime(
      `${date}T${DEFAULT_PREFERENCES.wakingTime}:00`,
      DEFAULT_PREFERENCES.timeZone,
    );
    const sleeping = fromZonedTime(
      `${date}T${DEFAULT_PREFERENCES.sleepingTime}:00`,
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
    blockedTimes: protectedBreaks.map(({ start, end }) => ({ start, end })),
    lockedSessions,
    preferences: { ...DEFAULT_PREFERENCES, planningMode },
  };
}

function scheduleFor(
  tasks: ExtractedTask[],
  planningMode: PlanningMode,
  preservedSessions: PlannedSession[] = [],
  preservedBreaks: ScheduledBreak[] = [],
): ScheduleProposal {
  const proposal = generateSchedule({
    ...schedulingBase(
      planningMode,
      tasks,
      preservedSessions.map(asExisting),
      preservedBreaks,
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

export function PlanPilotProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<ExtractedTask[]>([]);
  const [lastImportedTaskIds, setLastImportedTaskIds] = useState<string[]>([]);
  const [planningMode, setPlanningModeState] =
    useState<PlanningMode>("balanced");
  const [proposal, setProposal] = useState<ScheduleProposal>(() =>
    scheduleFor([], "balanced"),
  );
  const [importText, setImportText] = useState("");
  const [importState, setImportState] = useState<ImportState>("idle");
  const [extractionMode, setExtractionMode] = useState<ExtractionMode>();
  const [importError, setImportError] = useState<string>();
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [exportState, setExportState] =
    useState<PlanPilotContextValue["exportState"]>("idle");
  const [replan, setReplan] = useState<ReplanProposal>();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [sessionReviews, setSessionReviews] = useState<SessionReview[]>([]);
  const [scheduleUndoStack, setScheduleUndoStack] = useState<
    PlanningUndoSnapshot[]
  >([]);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [toast, setToast] = useState<string>();
  const [workspaceStatus, setWorkspaceStatus] =
    useState<WorkspaceStatus>("loading");
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
          const hasCommittedSessions = saved.proposal.sessions.some(
            (session) => session.status !== "proposed",
          );
          setProposal(
            saved.schedulerVersion === CURRENT_SCHEDULER_VERSION ||
              hasCommittedSessions
              ? saved.proposal
              : scheduleFor(saved.tasks, saved.planningMode),
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
      void fetch("/api/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          state: {
            version: 1,
            schedulerVersion: CURRENT_SCHEDULER_VERSION,
            tasks,
            proposal,
            importText,
            history,
            sessionReviews,
            planningMode,
            extractionMode,
            replan,
          },
        }),
      }).then((response) => {
        if (!response.ok) {
          setToast("A recent change could not be saved. Please try again.");
        }
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
        replan,
        selectedSessionIds,
        sessionReviews,
        lastImportedTaskIds,
      };
      setScheduleUndoStack((stack) => pushPlanningUndo(stack, snapshot));
    },
    [
      planningMode,
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
      setProposal(scheduleFor(nextTasks, nextMode));
      setReplan(undefined);
    },
    [planningMode],
  );

  const analyzeText = useCallback(async () => {
    setImportState("loading");
    setExtractionMode(undefined);
    setImportError(undefined);
    try {
      const response = await fetch("/api/extract", {
        method: "POST",
        signal: AbortSignal.timeout(35_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: importText,
          currentLocalDate: currentLocalDate(DEFAULT_PREFERENCES.timeZone),
          timeZone: DEFAULT_PREFERENCES.timeZone,
        }),
      });
      const body = (await response.json()) as {
        tasks?: ExtractedTask[];
        extractionMode?: ExtractionMode;
        error?: { message: string };
      };
      if (!response.ok || !body.tasks) {
        throw new Error(body.error?.message ?? "Extraction failed.");
      }
      const extractedTasks = body.tasks;
      const merged = mergeImportedTasks(tasks, extractedTasks);
      const preservedSessions = proposal.sessions;
      const preservedSessionIds = new Set(
        preservedSessions.map((session) => session.id),
      );
      const preservedBreaks = proposal.breaks.filter((item) =>
        preservedSessionIds.has(item.afterSessionId),
      );
      if (merged.addedTasks.length > 0) {
        rememberScheduleChange("responsibility import");
      }
      setTasks(merged.tasks);
      setLastImportedTaskIds(
        merged.addedTasks
          .map((task) => task.id)
          .filter((id): id is string => !!id),
      );
      setExtractionMode(body.extractionMode);
      setProposal(
        scheduleFor(
          merged.tasks,
          planningMode,
          preservedSessions,
          preservedBreaks,
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
          detail:
            body.extractionMode !== "local"
              ? `${body.extractionMode === "gemini" ? "Gemini" : "OpenAI"} estimated effort and session length; source text remains available for review.${merged.duplicateCount > 0 ? ` ${merged.duplicateCount} already-added responsibilities were skipped.` : ""}`
              : `Local fallback estimates were used; source text remains available for review.${merged.duplicateCount > 0 ? ` ${merged.duplicateCount} already-added responsibilities were skipped.` : ""}`,
        },
        ...items,
      ]);
      setToast(
        merged.addedTasks.length > 0
          ? `${merged.addedTasks.length} responsibilities added. Existing commitments were preserved.`
          : "Those responsibilities are already in your plan.",
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
  }, [importText, planningMode, proposal, rememberScheduleChange, tasks]);

  const updateTask = useCallback(
    (
      id: string,
      patch: Partial<ExtractedTask>,
      undoLabel = "task edit",
    ) => {
      if (!tasks.some((task) => task.id === id)) return;
      rememberScheduleChange(undoLabel);
      setTasks((current) => {
        const next = current.map((task) =>
          task.id === id ? { ...task, ...patch } : task,
        );
        refresh(next);
        return next;
      });
    },
    [refresh, rememberScheduleChange, tasks],
  );

  const approveTask = useCallback(
    (id: string) => {
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
    [updateTask],
  );

  const deleteTask = useCallback(
    (id: string) => {
      if (!tasks.some((task) => task.id === id)) return;
      rememberScheduleChange("task deletion");
      setTasks((current) => {
        const next = current.filter((task) => task.id !== id);
        refresh(next);
        return next;
      });
      setToast("Task removed.");
    },
    [refresh, rememberScheduleChange, tasks],
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
      const base = schedulingBase(planningMode, tasks);
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
        if (insideAvailability && !overlaps && end <= deadlineAt) {
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
    [planningMode, proposal, rememberScheduleChange, tasks],
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
      if (!response.ok) throw new Error("Calendar export failed.");
      setExportState("success");
      setToast(`${approved.length} approved sessions exported.`);
      setHistory((items) => [
        {
          id: `history-calendar-${Date.now()}`,
          at: nowLabel(),
          icon: "calendar",
          title: `${approved.length} sessions exported`,
          detail: "Created only after explicit approval.",
        },
        ...items,
      ]);
    } catch {
      setExportState("error");
      setToast("Calendar export failed. Your approved plan is unchanged.");
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
            scheduling: schedulingBase(planningMode, tasks),
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
    [planningMode, proposal.sessions, rememberScheduleChange, reviewQueue, tasks],
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
    setTheme((current) => {
      const next = current === "light" ? "dark" : "light";
      document.documentElement.classList.toggle("dark", next === "dark");
      return next;
    });
  }, []);

  const clearWorkspace = useCallback(() => {
    setTasks([]);
    setLastImportedTaskIds([]);
    setProposal(scheduleFor([], planningMode));
    setImportText("");
    setImportState("idle");
    setExtractionMode(undefined);
    setImportError(undefined);
    setSelectedSessionIds([]);
    setExportState("idle");
    setReplan(undefined);
    setHistory([]);
    setSessionReviews([]);
    setScheduleUndoStack([]);
    void fetch("/api/workspace", { method: "DELETE" });
    setToast("Workspace cleared. Planning preferences and theme were kept.");
  }, [planningMode]);

  const value = useMemo<PlanPilotContextValue>(
    () => ({
      tasks,
      lastImportedTaskIds,
      proposal,
      importText,
      setImportText,
      importState,
      extractionMode,
      importError,
      analyzeText,
      updateTask,
      approveTask,
      deleteTask,
      approveSession,
      approveAllSessions,
      toggleSessionLock,
      rejectSession,
      requestAnotherTime,
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
      importState,
      extractionMode,
      importError,
      analyzeText,
      updateTask,
      approveTask,
      deleteTask,
      approveSession,
      approveAllSessions,
      toggleSessionLock,
      rejectSession,
      requestAnotherTime,
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
