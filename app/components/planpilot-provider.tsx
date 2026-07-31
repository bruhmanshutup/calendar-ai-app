"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { generateSchedule } from "@/lib/domain/scheduler";
import { proposeMinimalReplan } from "@/lib/domain/rescheduler";
import type {
  ExtractedTask,
  ExistingSession,
  PlanningMode,
  ReplanProposal,
  ScheduleProposal,
} from "@/lib/domain/types";
import {
  DEMO_HISTORY,
  DEMO_PREFERENCES,
  DEMO_SCHEDULING_BASE,
  DEMO_TASKS,
  MISSED_DEMO_SESSION,
  type HistoryItem,
} from "@/lib/demo-data";

type ImportState = "idle" | "loading" | "success" | "error";

type PlanPilotContextValue = {
  tasks: ExtractedTask[];
  proposal: ScheduleProposal;
  importText: string;
  setImportText: (text: string) => void;
  importState: ImportState;
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
  proposeReplan: (outcome: "missed" | "partial", minutes?: number) => void;
  applyReplan: () => void;
  history: HistoryItem[];
  planningMode: PlanningMode;
  setPlanningMode: (mode: PlanningMode) => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  clearWorkspace: () => void;
  toast?: string;
  clearToast: () => void;
};

const Context = createContext<PlanPilotContextValue | null>(null);

function scheduleFor(
  tasks: ExtractedTask[],
  planningMode: PlanningMode,
): ScheduleProposal {
  return generateSchedule({
    ...DEMO_SCHEDULING_BASE,
    tasks,
    preferences: { ...DEMO_PREFERENCES, planningMode },
  });
}

export function PlanPilotProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<ExtractedTask[]>(DEMO_TASKS);
  const [planningMode, setPlanningModeState] =
    useState<PlanningMode>("balanced");
  const [proposal, setProposal] = useState<ScheduleProposal>(() =>
    scheduleFor(DEMO_TASKS, "balanced"),
  );
  const [importText, setImportText] = useState(
    "Chemistry exam Friday at 5 PM — review chapters 7–9. About 3 hours.\nGo to the gym four times this week, 45 minutes each.\nReturn library books by Friday.\nAdvisor appointment Thursday at 3 PM.\nFYI: the library entrance moved to Oak Street.",
  );
  const [importState, setImportState] = useState<ImportState>("idle");
  const [importError, setImportError] = useState<string>();
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [exportState, setExportState] =
    useState<PlanPilotContextValue["exportState"]>("idle");
  const [replan, setReplan] = useState<ReplanProposal>();
  const [history, setHistory] = useState<HistoryItem[]>(DEMO_HISTORY);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [toast, setToast] = useState<string>();

  const refresh = useCallback(
    (nextTasks: ExtractedTask[], nextMode = planningMode) => {
      setProposal(scheduleFor(nextTasks, nextMode));
    },
    [planningMode],
  );

  const analyzeText = useCallback(async () => {
    setImportState("loading");
    setImportError(undefined);
    try {
      const response = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: importText,
          currentLocalDate: "2026-07-30",
          timeZone: DEMO_PREFERENCES.timeZone,
        }),
      });
      const body = (await response.json()) as {
        tasks?: ExtractedTask[];
        error?: { message: string };
      };
      if (!response.ok || !body.tasks) {
        throw new Error(body.error?.message ?? "Extraction failed.");
      }
      setTasks(body.tasks);
      refresh(body.tasks);
      setImportState("success");
      setHistory((items) => [
        {
          id: `history-import-${Date.now()}`,
          at: "Just now",
          icon: "edit",
          title: `${body.tasks?.length ?? 0} responsibilities interpreted`,
          detail: "Source text is preserved beside every task for review.",
        },
        ...items,
      ]);
    } catch (error) {
      setImportState("error");
      setImportError(
        error instanceof Error
          ? error.message
          : "Extraction failed. Your text is still here to retry.",
      );
    }
  }, [importText, refresh]);

  const updateTask = useCallback(
    (id: string, patch: Partial<ExtractedTask>) => {
      setTasks((current) => {
        const next = current.map((task) =>
          task.id === id ? { ...task, ...patch } : task,
        );
        refresh(next);
        return next;
      });
    },
    [refresh],
  );

  const approveTask = useCallback(
    (id: string) => {
      updateTask(id, {
        approved: true,
        reviewRequired: false,
        missingInformation: [],
      });
      setToast("Task approved and included in the next proposal.");
    },
    [updateTask],
  );

  const deleteTask = useCallback(
    (id: string) => {
      setTasks((current) => {
        const next = current.filter((task) => task.id !== id);
        refresh(next);
        return next;
      });
      setToast("Incorrect extraction removed.");
    },
    [refresh],
  );

  const approveSession = useCallback((id: string) => {
    setProposal((current) => ({
      ...current,
      sessions: current.sessions.map((session) =>
        session.id === id ? { ...session, status: "approved" } : session,
      ),
    }));
  }, []);

  const approveAllSessions = useCallback(() => {
    setProposal((current) => ({
      ...current,
      sessions: current.sessions.map((session) => ({
        ...session,
        status: "approved",
      })),
    }));
    setSelectedSessionIds([]);
    setToast("Proposal approved. Nothing has been written to a calendar yet.");
  }, []);

  const toggleSessionLock = useCallback((id: string) => {
    setProposal((current) => ({
      ...current,
      sessions: current.sessions.map((session) =>
        session.id === id ? { ...session, locked: !session.locked } : session,
      ),
    }));
  }, []);

  const rejectSession = useCallback((id: string) => {
    setProposal((current) => ({
      ...current,
      sessions: current.sessions.filter((session) => session.id !== id),
    }));
    setToast("Session rejected. The task remains unscheduled.");
  }, []);

  const requestAnotherTime = useCallback(
    (id: string) => {
      setProposal((current) => {
        const target = current.sessions.find((session) => session.id === id);
        if (!target || target.locked) {
          setToast("Locked sessions must be unlocked before they can move.");
          return current;
        }
        const increment = 15 * 60_000;
        const duration =
          new Date(target.end).getTime() - new Date(target.start).getTime();
        let start = new Date(target.start).getTime() + increment;
        const deadline = tasks.find((task) => task.id === target.taskId)?.dueAt;
        const deadlineAt = deadline
          ? new Date(deadline).getTime()
          : new Date(DEMO_SCHEDULING_BASE.windowEnd).getTime();
        for (let attempt = 0; attempt < 48; attempt += 1) {
          const end = start + duration;
          const insideAvailability = DEMO_SCHEDULING_BASE.availability.some(
            (interval) =>
              start >= new Date(interval.start).getTime() &&
              end <= new Date(interval.end).getTime(),
          );
          const overlaps = current.sessions.some(
            (session) =>
              session.id !== id &&
              start < new Date(session.end).getTime() &&
              new Date(session.start).getTime() < end,
          );
          if (insideAvailability && !overlaps && end <= deadlineAt) {
            setToast("Moved to the next valid opening.");
            return {
              ...current,
              sessions: current.sessions
                .map((session) =>
                  session.id === id
                    ? {
                        ...session,
                        start: new Date(start).toISOString(),
                        end: new Date(end).toISOString(),
                        explanation:
                          "Moved to another valid opening at your request. The deadline and existing sessions remain protected.",
                      }
                    : session,
                )
                .sort(
                  (a, b) =>
                    new Date(a.start).getTime() -
                    new Date(b.start).getTime(),
                ),
            };
          }
          start += increment;
        }
        setToast(
          "No other valid opening fits before the deadline. Nothing moved.",
        );
        return current;
      });
    },
    [tasks],
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
      if (!response.ok) throw new Error("Mock calendar export failed.");
      setExportState("success");
      setToast(`${approved.length} approved sessions exported to mock calendar.`);
      setHistory((items) => [
        {
          id: `history-calendar-${Date.now()}`,
          at: "Just now",
          icon: "calendar",
          title: `${approved.length} sessions exported`,
          detail: "Created only after explicit approval using mock calendar.",
        },
        ...items,
      ]);
    } catch {
      setExportState("error");
      setToast("Calendar export failed. Your approved plan is unchanged.");
    }
  }, [proposal.sessions]);

  const proposeReplan = useCallback(
    (outcome: "missed" | "partial", minutes?: number) => {
      const chemistry = tasks.find((task) => task.id === "chemistry");
      if (!chemistry) return;
      const existing = proposal.sessions.map<ExistingSession>((session) => ({
        id: session.id,
        taskId: session.taskId,
        title: session.title,
        start: session.start,
        end: session.end,
        locked: session.locked,
        status:
          session.status === "completed"
            ? "completed"
            : session.status === "approved"
              ? "approved"
              : "proposed",
      }));
      setReplan(
        proposeMinimalReplan({
          session: MISSED_DEMO_SESSION,
          outcome,
          minutesCompleted: minutes,
          sessions: [MISSED_DEMO_SESSION, ...existing],
          task: chemistry,
          scheduling: {
            ...DEMO_SCHEDULING_BASE,
            preferences: { ...DEMO_PREFERENCES, planningMode },
          },
        }),
      );
    },
    [planningMode, proposal.sessions, tasks],
  );

  const applyReplan = useCallback(() => {
    if (!replan) return;
    setProposal((current) => {
      let sessions = [...current.sessions];
      for (const change of replan.changes) {
        if (change.type === "remove") {
          sessions = sessions.filter(
            (session) => session.id !== change.sessionId,
          );
        } else if (change.type === "move") {
          sessions = sessions.filter(
            (session) => session.id !== change.sessionId,
          );
          sessions.push(change.after);
        } else {
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
    setHistory((items) => [
      {
        id: `history-replan-${Date.now()}`,
        at: "Just now",
        icon: "move",
        title: "Chemistry review rescheduled",
        detail: replan.explanation,
      },
      ...items,
    ]);
    setToast("Schedule change applied.");
    setReplan(undefined);
  }, [replan]);

  const setPlanningMode = useCallback(
    (mode: PlanningMode) => {
      setPlanningModeState(mode);
      refresh(tasks, mode);
      setToast(
        `${mode[0].toUpperCase()}${mode.slice(1)} planning rules applied.`,
      );
    },
    [refresh, tasks],
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
    setProposal(scheduleFor([], planningMode));
    setImportText("");
    setImportState("idle");
    setImportError(undefined);
    setSelectedSessionIds([]);
    setExportState("idle");
    setReplan(undefined);
    setHistory([]);
    setToast(
      "Demo workspace cleared. Your planning preferences and theme were kept.",
    );
  }, [planningMode]);

  const value = useMemo<PlanPilotContextValue>(
    () => ({
      tasks,
      proposal,
      importText,
      setImportText,
      importState,
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
      proposeReplan,
      applyReplan,
      history,
      planningMode,
      setPlanningMode,
      theme,
      toggleTheme,
      clearWorkspace,
      toast,
      clearToast: () => setToast(undefined),
    }),
    [
      tasks,
      proposal,
      importText,
      importState,
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
      proposeReplan,
      applyReplan,
      history,
      planningMode,
      setPlanningMode,
      theme,
      toggleTheme,
      clearWorkspace,
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
