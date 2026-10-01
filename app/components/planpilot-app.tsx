"use client";

import Link from "next/link";
import { fromZonedTime } from "date-fns-tz";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Clock3,
  Download,
  FileText,
  History,
  Home,
  Info,
  LayoutList,
  Lock,
  LockOpen,
  Menu,
  Moon,
  MoreHorizontal,
  MoveRight,
  PanelLeft,
  PencilLine,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  Sparkles,
  Sun,
  Target,
  Trash2,
  Undo2,
  Upload,
  UserRound,
  Waypoints,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import packageJson from "@/package.json";
import { specificExplanation } from "@/lib/domain/explanations";
import { DEFAULT_PREFERENCES } from "@/lib/defaults";
import { extractionFallbackNotice } from "@/lib/domain/extraction-diagnostics";
import {
  countImportWords,
  MAX_AI_IMPORT_WORDS,
} from "@/lib/domain/import-limits";
import {
  deadlineUpdateFields,
  isManualPlacementAfterDeadline,
  manualPlacementEnd,
  manualPlacementStart,
  taskDeadlineInstant,
} from "@/lib/domain/manual-placement";
import {
  previewPlanAdjustment,
  type PlanAdjustmentPreview,
} from "@/lib/domain/plan-adjustment";
import type {
  DayOfWeek,
  ExtractedTask,
  PlannedSession,
  PlanningMode,
  ScheduleReasonCode,
  UnschedulableTask,
} from "@/lib/domain/types";
import { DocumentImport, TaskDocumentSource } from "./document-import";
import type { DocumentReference } from "@/lib/domain/document-import";
import { prepareGlobalInstructions } from "@/lib/domain/global-instructions";
import {
  DAYS_OF_WEEK,
  groupRecurrenceDaySchedules,
  recurrenceTimesForDay,
} from "@/lib/domain/recurrence";
import {
  setCustomTaskSchedulingWindow,
  setTaskSchedulingPreference,
  TASK_SCHEDULING_PREFERENCE_OPTIONS,
  taskSchedulingPreference,
  type TaskSchedulingPreference,
} from "@/lib/domain/task-scheduling-preference";
import { taskSequence } from "@/lib/domain/task-sequence";
import { taskFieldOrigin } from "@/lib/domain/task-provenance";
import { arrivalBufferReservations } from "@/lib/domain/linked-timing";
import {
  extractionModeImportSummary,
  usePlanPilot,
} from "./planpilot-provider";
import { LandingExperience } from "./landing";
import {
  AppBackdrop,
  PlanOrbit,
  RouteIllustration,
  SkeletonPanel,
  WaypointDots,
  type OrbitBlock,
} from "./visuals";

export type PlanPilotView =
  | "landing"
  | "login"
  | "onboarding"
  | "dashboard"
  | "import"
  | "review"
  | "schedule"
  | "daily-review"
  | "changes"
  | "settings";

const APP_NAV: Array<{
  href: string;
  label: string;
  icon: LucideIcon;
  view: PlanPilotView;
}> = [
  { href: "/dashboard", label: "Overview", icon: Home, view: "dashboard" },
  { href: "/import", label: "Add responsibilities", icon: Plus, view: "import" },
  { href: "/tasks/review", label: "Tasks", icon: LayoutList, view: "review" },
  { href: "/schedule", label: "Schedule", icon: CalendarDays, view: "schedule" },
  {
    href: "/daily-review",
    label: "Daily review",
    icon: CheckCircle2,
    view: "daily-review",
  },
];

/** Less-used pages, tucked behind the "⋯" button so the main tabs stay short. */
const MORE_NAV: typeof APP_NAV = [
  { href: "/changes", label: "Changes", icon: History, view: "changes" },
  { href: "/settings", label: "Settings", icon: Settings, view: "settings" },
];

const REASON_LABELS: Record<ScheduleReasonCode, string> = {
  OVERDUE_RECOVERY: "Overdue recovery",
  DEADLINE_RISK: "Deadline risk",
  PREFERRED_FOCUS_WINDOW: "Focus window",
  PREFERRED_ROUTINE_WINDOW: "Routine window",
  PRIORITY: "High priority",
  EARLY_COMPLETION: "Early completion",
  SPLIT_TO_REDUCE_FATIGUE: "Reduced fatigue",
  RECURRING_SPACING: "Healthy spacing",
  BUFFER_PRESERVED: "Buffer preserved",
  LOW_ENERGY_FIT: "Energy fit",
  TASK_TIME_WINDOW: "Task time window",
  REST_DAY_SPACING: "Rest-day spacing",
  FINAL_VALID_OPENING: "Final opening",
  STABILITY_PRESERVED: "Kept stable",
  MOVED_AFTER_MISSED: "Missed recovery",
  SEQUENCE_ORDER: "Plan order",
  FIXED_TIME: "Fixed time",
  USER_PLACEMENT: "Your placement",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_PREFERENCES.timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

/** Short calendar-style range: "10–10:50am", "11:30am–12:20pm". */
function compactTimeRange(start: string, end: string): string {
  const part = (value: string) => {
    const [clock, meridiem] = formatTime(value).split(" ");
    return { clock: clock.replace(/:00$/, ""), meridiem: (meridiem ?? "").toLowerCase() };
  };
  const from = part(start);
  const to = part(end);
  return from.meridiem === to.meridiem
    ? `${from.clock}–${to.clock}${to.meridiem}`
    : `${from.clock}${from.meridiem}–${to.clock}${to.meridiem}`;
}

function formatDay(value: string, long = false): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_PREFERENCES.timeZone,
    weekday: long ? "long" : "short",
    month: long ? "long" : "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatToday(long = false): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_PREFERENCES.timeZone,
    weekday: long ? "long" : "short",
    month: long ? "long" : "short",
    day: "numeric",
  }).format(new Date());
}

function localDateKey(value = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_PREFERENCES.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function timeZoneName(): string {
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_PREFERENCES.timeZone,
      timeZoneName: "longGeneric",
    })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? DEFAULT_PREFERENCES.timeZone
  );
}

function localTimeKey(value: string | Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_PREFERENCES.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(typeof value === "string" ? new Date(value) : value);
  const get = (type: "hour" | "minute") =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("hour")}:${get("minute")}`;
}

function shortDate(value?: string): string {
  if (!value) return "Not specified";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(new Date(`${value}T12:00:00Z`));
}

const SHORT_DAY_LABELS: Record<DayOfWeek, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

function formatClockTime(value: string): string {
  const [hour, minute] = value.split(":").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(Date.UTC(2026, 0, 1, hour, minute)));
}

function formatRecurringDays(days: DayOfWeek[]): string {
  if (days.length === 7) return "Daily";
  if (
    days.length === 5 &&
    DAYS_OF_WEEK.slice(0, 5).every((day) => days.includes(day))
  ) {
    return "Weekdays";
  }
  if (
    days.length === 2 &&
    DAYS_OF_WEEK.slice(5).every((day) => days.includes(day))
  ) {
    return "Weekends";
  }
  return days.map((day) => SHORT_DAY_LABELS[day]).join(", ");
}

function recurrenceSummary(task: ExtractedTask): string {
  const recurrence = task.recurrence;
  if (!recurrence) return "Not configured";
  if (recurrence.mode === "fixed_times") {
    const interval = recurrence.interval ?? 1;
    const intervalLabel =
      interval > 1
        ? `Every ${interval} ${recurrence.frequency === "daily" ? "days" : recurrence.frequency === "weekly" ? "weeks" : "months"}: `
        : "";
    const weekly = recurrence.timeRules
      ?.map(
        (rule) =>
          `${formatRecurringDays(rule.daysOfWeek)} at ${formatClockTime(rule.time)}`,
      )
      .join(" · ");
    const ordinalLabel: Record<number, string> = {
      1: "First",
      2: "Second",
      3: "Third",
      4: "Fourth",
      5: "Fifth",
      [-1]: "Last",
    };
    const monthly = recurrence.monthlyRules
      ?.map((rule) =>
        rule.type === "days_of_month"
          ? `Monthly on ${rule.daysOfMonth.join(", ")} at ${rule.times.map(formatClockTime).join(" and ")}`
          : rule.type === "last_day_of_month"
            ? `Last day monthly at ${rule.times.map(formatClockTime).join(" and ")}`
            : `${ordinalLabel[rule.ordinal]} ${SHORT_DAY_LABELS[rule.dayOfWeek]} monthly at ${rule.times.map(formatClockTime).join(" and ")}`,
      )
      .join(" · ");
    const exceptions = recurrence.dateOverrides?.length
      ? ` · ${recurrence.dateOverrides.length} date exception${recurrence.dateOverrides.length === 1 ? "" : "s"}`
      : "";
    const limit = recurrence.occurrenceLimit
      ? ` for ${recurrence.occurrenceLimit} occurrence${recurrence.occurrenceLimit === 1 ? "" : "s"}`
      : "";
    const anchor = recurrence.anchorDate
      ? ` starting ${shortDate(recurrence.anchorDate)}`
      : "";
    const ending = recurrence.windowEnd
      ? ` through ${formatDay(recurrence.windowEnd)}`
      : "";
    return `${intervalLabel}${weekly || monthly || "Times need review"}${anchor}${ending}${limit}${exceptions}`;
  }
  const count = recurrence.count ?? 1;
  return `${count} time${count === 1 ? "" : "s"} ${recurrence.frequency}`;
}

function preferredDateWindowSummary(task: ExtractedTask): string | undefined {
  const windows = task.schedulingConstraints?.preferredDateWindows;
  if (!windows?.length) return undefined;
  return windows.map((window) => `${datedIntervalSummary(window.start, window.end)} · ${window.label} (suggested)`).join("; ");
}

function datedIntervalSummary(start: string, end: string): string {
  const sameDate = localDateKey(new Date(start)) === localDateKey(new Date(end));
  return sameDate
    ? `${formatDay(start, true)} · ${formatTime(start)}–${formatTime(end)}`
    : `${formatDay(start, true)} at ${formatTime(start)} – ${formatDay(end, true)} at ${formatTime(end)}`;
}

function taskTimingSummary(
  task: ExtractedTask,
  includePreferredDateWindows = true,
): string | undefined {
  const constraints = task.schedulingConstraints;
  if (!constraints) return undefined;
  const parts: string[] = [];
  if (constraints.allowedTimeWindows?.length) {
    parts.push(
      `Only ${constraints.allowedTimeWindows
        .map((window) => `${formatClockTime(window.start)}–${formatClockTime(window.end)}`)
        .join(", ")}`,
    );
  }
  if (constraints.preferredTimeWindows?.length) {
    parts.push(
      `Prefer ${constraints.preferredTimeWindows
        .map((window) => `${formatClockTime(window.start)}–${formatClockTime(window.end)}`)
        .join(", ")}`,
    );
  }
  if (includePreferredDateWindows && constraints.preferredDateWindows?.length) {
    parts.push(preferredDateWindowSummary(task)!);
  }
  if (constraints.avoidConsecutiveDays) parts.push("Rest days when possible");
  if (constraints.sessionCount) parts.push(`${constraints.sessionCount} sessions`);
  return parts.join(" · ") || undefined;
}

function fixedTimeSummary(task: ExtractedTask): string {
  if (!task.fixedStartAt) return "Start time needs review";

  if (!task.fixedEndAt) {
    return `${formatDay(task.fixedStartAt, true)} at ${formatTime(task.fixedStartAt)} · end time needed`;
  }

  return datedIntervalSummary(task.fixedStartAt, task.fixedEndAt);
}

function localDateTimeValue(value?: string): string {
  if (!value) return "";
  return `${localDateKey(new Date(value))}T${localTimeKey(value)}`;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="brand" href="/">
      <span className="brand-mark" aria-hidden="true">
        <Waypoints size={compact ? 18 : 20} strokeWidth={2.3} />
      </span>
      <span className="brand-name">PlanPilot</span>
      <span className="brand-version" title={`PlanPilot version ${packageJson.version}`}>
        v{packageJson.version}
      </span>
    </Link>
  );
}

function Button({
  children,
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
}) {
  return (
    <button
      className={`button button-${variant} button-${size} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function FieldConfidenceIndicator({
  label,
  confidence,
}: {
  label: string;
  confidence?: number;
}) {
  if (confidence === undefined) return null;
  const tone =
    confidence >= 0.85 ? "high" : confidence >= 0.65 ? "medium" : "low";
  return (
    <span
      className={`confidence confidence-${tone}`}
      title={`${Math.round(confidence * 100)}% field confidence`}
    >
      <span aria-hidden="true" />
      {label}
      {tone === "low" ? " · check" : ""}
    </span>
  );
}

function FieldOriginBadge({
  task,
  path,
}: {
  task: ExtractedTask;
  path: string;
}) {
  const origin = taskFieldOrigin(task, path);
  if (!origin) return null;
  const labels = {
    explicit: "From text",
    derived: "Calculated",
    inferred: "Suggested",
    user: "Your edit",
  } as const;
  const details = {
    explicit: "Copied from the source you supplied.",
    derived: "Calculated deterministically from source details.",
    inferred: "A planning suggestion, not a supplied fact.",
    user: "Changed by you after interpretation.",
  } as const;
  return (
    <span className={`field-origin field-origin-${origin}`} title={task.fieldProvenance?.find((field) => field.path === path)?.rationale ?? details[origin]}>
      {labels[origin]}
    </span>
  );
}

export function ScheduleReason({
  reasons,
  explanation,
  expanded,
  onExpandedChange,
}: {
  reasons: ScheduleReasonCode[];
  explanation: string;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const isExpanded = expanded ?? localExpanded;
  const toggle = () => {
    const next = !isExpanded;
    if (onExpandedChange) onExpandedChange(next);
    else setLocalExpanded(next);
  };
  return (
    <div className="reason-block">
      <button
        type="button"
        className="reason-toggle"
        aria-expanded={isExpanded}
        onClick={toggle}
      >
        <Sparkles size={12} aria-hidden="true" />
        Why this time?
        {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      {isExpanded && (
        <div className="reason-details">
          <div className="reason-tags">
            {reasons.slice(0, 3).map((reason) => (
              <span key={reason}>
                <Sparkles size={12} aria-hidden="true" />
                {REASON_LABELS[reason]}
              </span>
            ))}
          </div>
          <p>{explanation}</p>
        </div>
      )}
    </div>
  );
}

export function PlanHealthPanel({ compact = false }: { compact?: boolean }) {
  const { proposal } = usePlanPilot();
  const health = proposal.planHealth;
  return (
    <section className={`plan-health ${compact ? "plan-health-compact" : ""}`}>
      <div className="plan-health-heading">
        <div>
          <span className="eyebrow">
            <ShieldCheck size={15} aria-hidden="true" />
            Plan health
          </span>
          <h2>{health.scheduledPercent === 100 ? "Everything fits" : `${health.scheduledPercent}% of your work fits`}</h2>
          {health.scheduledPercent < 100 && <p>{health.summary}</p>}
        </div>
        <div
          className="health-ring"
          style={
            {
              "--health-progress": `${health.scheduledPercent * 3.6}deg`,
            } as React.CSSProperties
          }
          aria-label={`${health.scheduledPercent}% scheduled`}
        >
          <strong>{health.scheduledPercent}%</strong>
          <span>scheduled</span>
        </div>
      </div>
      <div className="health-metrics">
        <div>
          <span className="metric-icon metric-icon-green">
            <Clock3 size={16} />
          </span>
          <p>Buffer retained</p>
          <strong>{Math.floor(health.bufferMinutesRetained / 60)}h {health.bufferMinutesRetained % 60}m</strong>
        </div>
        <div>
          <span className="metric-icon metric-icon-amber">
            <AlertTriangle size={16} />
          </span>
          <p>Deadlines at risk</p>
          <strong>{health.deadlinesAtRisk}</strong>
        </div>
        <div>
          <span className="metric-icon metric-icon-blue">
            <Zap size={16} />
          </span>
          <p>Demanding blocks</p>
          <strong>{health.demandingFocusBlocks}</strong>
        </div>
        <div>
          <span className="metric-icon metric-icon-purple">
            <Target size={16} />
          </span>
          <p>Recurring on track</p>
          <strong>
            {health.recurringGoalsOnTrack}/{health.recurringGoalsOnTrack + health.recurringGoalsBehind}
          </strong>
        </div>
      </div>
    </section>
  );
}

export function EmptyState({
  icon: Icon = FileText,
  illustration,
  title,
  detail,
  action,
}: {
  icon?: LucideIcon;
  illustration?: "route" | "clear" | "history" | "inbox";
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {illustration ? (
        <RouteIllustration variant={illustration} />
      ) : (
        <span><Icon size={22} /></span>
      )}
      <h3>{title}</h3>
      <p>{detail}</p>
      {action}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="state-card state-error" role="alert">
      <AlertTriangle size={20} />
      <div>
        <strong>We couldn’t finish the interpretation</strong>
        <p>{message}</p>
      </div>
      <Button variant="secondary" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function LoadingState() {
  return (
    <div className="state-card" aria-live="polite">
      <RefreshCw className="spin" size={19} />
      <div>
        <strong>Separating tasks from context…</strong>
        <p>Your pasted text stays visible while PlanPilot checks uncertainty.</p>
      </div>
    </div>
  );
}

function Toast() {
  const { toast, clearToast } = usePlanPilot();
  // Auto-dismiss after a readable delay; long messages get a little longer.
  useEffect(() => {
    if (!toast) return;
    const delay = Math.min(9000, 4500 + toast.length * 25);
    const timer = window.setTimeout(clearToast, delay);
    return () => window.clearTimeout(timer);
  }, [toast, clearToast]);
  if (!toast) return null;
  return (
    <div className="toast" role="status" aria-live="polite">
      <CheckCircle2 size={18} aria-hidden="true" />
      <span>{toast}</span>
      <button onClick={clearToast} aria-label="Dismiss message">
        <X size={16} />
      </button>
    </div>
  );
}

const BOTTOM_NAV = APP_NAV.slice(0, 4);

function DockMoreMenu({ view }: { view: PlanPilotView }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  const activeItem = MORE_NAV.find((item) => item.view === view);
  return (
    <div className="dock-more" ref={menuRef}>
      <button
        type="button"
        className={`dock-more-button ${activeItem ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={activeItem ? `More pages, ${activeItem.label} open` : "More pages"}
        title="Changes and settings"
        onClick={() => setOpen((current) => !current)}
      >
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      {open && (
        <div className="dock-more-menu" role="menu">
          {MORE_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                role="menuitem"
                href={item.href}
                key={item.href}
                className={item.view === view ? "active" : ""}
                aria-current={item.view === view ? "page" : undefined}
                onClick={() => setOpen(false)}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AppShellSkeleton() {
  return (
    <div className="skeleton-page" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your workspace…</span>
      <SkeletonPanel rows={2} />
      <SkeletonPanel rows={4} />
    </div>
  );
}

function AppShell({
  view,
  children,
}: {
  view: PlanPilotView;
  children: ReactNode;
}) {
  const {
    theme,
    toggleTheme,
    clearWorkspace,
    reviewQueue,
    workspaceStatus,
  } = usePlanPilot();
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileOpen]);
  const closeDrawer = () => setMobileOpen(false);
  const confirmClearWorkspace = () => {
    if (
      window.confirm(
        "Clear all tasks, imported text, scheduled sessions, review outcomes, recovery changes, selections, and history? Planning preferences and theme will be kept. This cannot be undone.",
      )
    ) {
      clearWorkspace();
    }
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <AppBackdrop />
      <nav className="app-dock" aria-label="Main navigation">
        <Brand compact />
        <div className="dock-links">
          {APP_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                href={item.href}
                key={item.href}
                className={item.view === view ? "active" : ""}
                aria-current={item.view === view ? "page" : undefined}
                title={item.label}
              >
                <Icon size={17} aria-hidden="true" />
                <span>{item.label === "Add responsibilities" ? "Add" : item.label}</span>
                {item.view === "daily-review" && reviewQueue.length > 0 && <i>{reviewQueue.length}</i>}
              </Link>
            );
          })}
          <DockMoreMenu view={view} />
        </div>
        <div className="dock-right">
          <span className="dock-status" role="status">
            <span className={`sync-dot ${workspaceStatus}`} aria-hidden="true" />
            <span className="sr-only">
              {workspaceStatus === "loading" ? "Loading workspace" : workspaceStatus === "ready" ? "Workspace saved" : "Storage unavailable"}
            </span>
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={toggleTheme}
            aria-pressed={theme === "dark"}
            aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            title={theme === "light" ? "Dark mode" : "Light mode"}
          >
            {theme === "light" ? <Moon size={17} aria-hidden="true" /> : <Sun size={17} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={confirmClearWorkspace}
            aria-label="Clear workspace"
            title="Clear workspace"
          >
            <Trash2 size={17} aria-hidden="true" />
          </button>
          <Link href="/import" className="topbar-add">
            <Plus size={17} aria-hidden="true" />
            Add
          </Link>
        </div>
      </nav>
      <div
        className={`sidebar-backdrop ${mobileOpen ? "open" : ""}`}
        aria-hidden="true"
        onClick={() => setMobileOpen(false)}
      />
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <Brand compact />
          <button
            className="mobile-close"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          >
            <X size={19} />
          </button>
        </div>
        <nav aria-label="Main navigation">
          {APP_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                href={item.href}
                key={item.href}
                className={item.view === view ? "active" : ""}
                aria-current={item.view === view ? "page" : undefined}
                onClick={closeDrawer}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
                {item.view === "daily-review" && reviewQueue.length > 0 && (
                  <i>{reviewQueue.length}</i>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-spacer" />
        <nav aria-label="Secondary navigation">
          {MORE_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                href={item.href}
                key={item.href}
                className={item.view === view ? "active" : ""}
                aria-current={item.view === view ? "page" : undefined}
                onClick={closeDrawer}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
          <button onClick={toggleTheme} className="sidebar-action" aria-pressed={theme === "dark"}>
            {theme === "light" ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}
            <span>{theme === "light" ? "Dark mode" : "Light mode"}</span>
          </button>
          <Link className="sidebar-action" href="/#how-it-works" onClick={closeDrawer}>
            <CircleHelp size={18} aria-hidden="true" />
            <span>How PlanPilot works</span>
          </Link>
        </nav>
        <div className="profile-chip">
          <span>PP</span>
          <div>
            <strong>Personal plan</strong>
            <small>Private workspace</small>
          </div>
          <MoreHorizontal size={17} />
        </div>
      </aside>
      <main className="app-main">
        <header className="app-topbar">
          <button
            className="mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={21} />
          </button>
          <div className="topbar-context" role="status">
            <span className={`sync-dot ${workspaceStatus}`} aria-hidden="true" />
            {workspaceStatus === "loading"
              ? "Loading workspace"
              : workspaceStatus === "ready"
                ? "Workspace saved"
                : "Storage unavailable"}
          </div>
          <div className="topbar-right">
            <span>{formatToday()}</span>
            <button
              type="button"
              className="topbar-clear"
              onClick={confirmClearWorkspace}
              aria-label="Clear workspace"
            >
              <Trash2 size={16} aria-hidden="true" />
              <span>Clear all</span>
            </button>
            <Link href="/import" className="topbar-add">
              <Plus size={17} aria-hidden="true" />
              Add
            </Link>
          </div>
        </header>
        <div className="app-content" id="main-content" tabIndex={-1}>
          {workspaceStatus === "loading" ? <AppShellSkeleton /> : children}
        </div>
      </main>
      <nav className="bottom-nav" aria-label="Primary navigation">
        {BOTTOM_NAV.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              href={item.href}
              key={item.href}
              className={item.view === view ? "active" : ""}
              aria-current={item.view === view ? "page" : undefined}
            >
              <Icon size={22} aria-hidden="true" />
              <span>{item.label === "Add responsibilities" ? "Add" : item.label}</span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="More navigation"
          aria-expanded={mobileOpen}
        >
          <Menu size={22} aria-hidden="true" />
          <span>More</span>
          {reviewQueue.length > 0 && <i>{reviewQueue.length}</i>}
        </button>
      </nav>
      <Toast />
    </div>
  );
}

function LoginView() {
  const [email, setEmail] = useState("");
  return (
    <div className="auth-page">
      <div className="auth-brand"><Brand /></div>
      <section className="auth-card">
        <span className="auth-icon"><UserRound size={23} /></span>
        <h1>Welcome back</h1>
        <p>Sign in to review your plan and today’s work.</p>
        <label>
          Email address
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
          />
        </label>
        <label>
          Password
          <input type="password" placeholder="••••••••••••" />
        </label>
        <Link className="button button-primary button-lg auth-submit" href="/dashboard">
          Sign in
          <ArrowRight size={16} />
        </Link>
        <div className="auth-divider"><span>or</span></div>
        <Link className="button button-secondary button-md auth-submit" href="/dashboard">
          Continue in demo mode
        </Link>
        <small>
          Supabase authentication activates when project credentials are configured.
          Demo mode uses no production account.
        </small>
      </section>
    </div>
  );
}

function OnboardingView() {
  const [step, setStep] = useState(1);
  const [weekends, setWeekends] = useState(true);
  const [mode, setMode] = useState<PlanningMode>("balanced");
  return (
    <div className="onboarding-page">
      <header><Brand /><span>Set up your planning rules</span></header>
      <main>
        <div className="stepper" aria-label={`Step ${step} of 3`}>
          {[1, 2, 3].map((item) => (
            <span key={item} className={item <= step ? "active" : ""}>
              {item < step ? <Check size={13} /> : item}
            </span>
          ))}
          <i /><i />
        </div>
        {step === 1 && (
          <section className="onboarding-card">
            <span className="eyebrow">STEP 1 OF 3</span>
            <h1>Start with your real day</h1>
            <p>These boundaries are hard constraints. PlanPilot will not schedule through them.</p>
            <div className="form-grid">
              <label>Name<input defaultValue="Alex Morgan" /></label>
              <label>
                IANA time zone
                <select defaultValue={DEFAULT_PREFERENCES.timeZone}>
                  <option>America/Chicago</option>
                  <option>America/Los_Angeles</option>
                  <option>America/New_York</option>
                  <option>Europe/London</option>
                  <option>Asia/Tokyo</option>
                </select>
              </label>
              <label>Usually awake at<input type="time" defaultValue="07:00" /></label>
              <label>Usually asleep at<input type="time" defaultValue="23:00" /></label>
            </div>
            <div className="onboarding-actions">
              <span>Saved later to your Supabase profile</span>
              <Button size="lg" onClick={() => setStep(2)}>Continue <ArrowRight size={16} /></Button>
            </div>
          </section>
        )}
        {step === 2 && (
          <section className="onboarding-card">
            <span className="eyebrow">STEP 2 OF 3</span>
            <h1>When can work realistically happen?</h1>
            <p>Recurring availability becomes a boundary, not a suggestion.</p>
            <div className="availability-table">
              {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((day) => (
                <div key={day}>
                  <label><input type="checkbox" defaultChecked /> {day}</label>
                  <input type="time" defaultValue="16:00" aria-label={`${day} start`} />
                  <span>to</span>
                  <input type="time" defaultValue="21:00" aria-label={`${day} end`} />
                </div>
              ))}
            </div>
            <label className="switch-row">
              <span><strong>Use weekends when needed</strong><small>Still preserve planning-mode buffer.</small></span>
              <input type="checkbox" checked={weekends} onChange={(event) => setWeekends(event.target.checked)} />
            </label>
            <div className="onboarding-actions">
              <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
              <Button size="lg" onClick={() => setStep(3)}>Continue <ArrowRight size={16} /></Button>
            </div>
          </section>
        )}
        {step === 3 && (
          <section className="onboarding-card">
            <span className="eyebrow">STEP 3 OF 3</span>
            <h1>Choose how much breathing room to keep</h1>
            <p>Every mode has explicit scheduling behavior. Hard constraints never change.</p>
            <div className="mode-cards">
              {([
                ["conservative", "25% buffer", "Up to 2 demanding blocks a day. Finish earlier."],
                ["balanced", "15% buffer", "Up to 3 demanding blocks. Balance margin and flexibility."],
                ["aggressive", "5% buffer", "Denser plans, while still protecting hard constraints."],
              ] as const).map(([value, label, detail]) => (
                <button
                  key={value}
                  className={mode === value ? "selected" : ""}
                  onClick={() => setMode(value)}
                >
                  <span>{mode === value ? <Check size={14} /> : null}</span>
                  <strong>{value[0].toUpperCase() + value.slice(1)}</strong>
                  <b>{label}</b>
                  <p>{detail}</p>
                </button>
              ))}
            </div>
            <div className="onboarding-actions">
              <Button variant="ghost" onClick={() => setStep(2)}>Back</Button>
              <Link className="button button-primary button-lg" href="/dashboard">
                Finish setup <ArrowRight size={16} />
              </Link>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function PageHeading({
  eyebrow,
  title,
  detail,
  actions,
}: {
  eyebrow?: string;
  title: string;
  detail?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && (
          <span className="eyebrow">
            <WaypointDots />
            {eyebrow}
          </span>
        )}
        <h1>{title}</h1>
        {detail && <p>{detail}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

function clockMinutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return (hour || 0) * 60 + (minute || 0);
}

const ORBIT_TONES: OrbitBlock["tone"][] = ["violet", "cyan", "coral", "amber"];
const MINUTES_PER_DAY = 24 * 60;

/** Wall-clock time read after mount (and refreshed every minute) so render stays pure. */
function useClock(intervalMs = 60_000): number | undefined {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function DashboardView() {
  const { proposal, tasks, history, sessionReviews } = usePlanPilot();
  const now = useClock();
  const todayKey = localDateKey();
  const todaySessions = proposal.sessions.filter(
    (session) => localDateKey(new Date(session.start)) === todayKey,
  );
  const shownSessions = todaySessions;

  // 3D day ring: map today's sessions onto the 24-hour ring.
  const nowMinutes = now === undefined ? clockMinutes(DEFAULT_PREFERENCES.wakingTime) : clockMinutes(localTimeKey(new Date(now)));
  const dayProgress = Math.max(0, Math.min(1, nowMinutes / MINUTES_PER_DAY));
  const orbitBlocks: OrbitBlock[] = todaySessions.slice(0, 8).map((session, index) => ({
    label: `${session.title} · ${formatTime(session.start)}`,
    start: clockMinutes(localTimeKey(session.start)) / MINUTES_PER_DAY,
    width: Math.max(0.02, Math.min(0.3, session.minutes / MINUTES_PER_DAY)),
    tone: ORBIT_TONES[index % ORBIT_TONES.length],
  }));

  // Real numbers for the side cards (no placeholder copy).
  const weekAgo = (now ?? 0) - 7 * 24 * 60 * 60_000;
  const weekReviews = sessionReviews.filter(
    (review) =>
      now !== undefined &&
      new Date(review.reviewedAt).getTime() >= weekAgo &&
      (review.outcome === "completed" || review.outcome === "partial"),
  );
  const completedMinutes = weekReviews.reduce((sum, review) => sum + review.completedMinutes, 0);
  const upcomingDeadlines = tasks
    .filter((task) => task.dueDate && !task.completed && !task.cancelled)
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""))
    .slice(0, 4);
  const unscheduledMinutes = proposal.planHealth.unscheduledMinutes;
  const firstUnschedulable = proposal.unschedulable[0];
  const bestOption = firstUnschedulable?.suggestedActions[0];
  const todayMinutes = shownSessions.reduce((sum, session) => sum + session.minutes, 0);

  // Split today's sessions at the current moment. Until the clock is known
  // (first render), everything counts as upcoming.
  const orderedToday = [...shownSessions].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );
  const isPast = (session: PlannedSession) =>
    now !== undefined && new Date(session.end).getTime() <= now;
  const isNow = (session: PlannedSession) =>
    now !== undefined &&
    new Date(session.start).getTime() <= now &&
    now < new Date(session.end).getTime();
  const upcomingToday = orderedToday.filter((session) => !isPast(session));
  const pastToday = orderedToday.filter(isPast);
  const minutesLeft = upcomingToday.reduce((sum, session) => {
    if (!isNow(session) || now === undefined) return sum + session.minutes;
    return sum + Math.max(0, Math.round((new Date(session.end).getTime() - now) / 60_000));
  }, 0);
  const renderTodaySession = (session: PlannedSession) => {
    const index = orderedToday.indexOf(session);
    const past = isPast(session);
    const current = isNow(session);
    const note = specificExplanation(session.explanation);
    return (
      <article key={session.id} className={`today-item ${past ? "is-past" : ""} ${current ? "is-now" : ""}`}>
        <div className="today-time">
          <strong>{formatTime(session.start)}</strong>
          <span>{formatTime(session.end)}</span>
        </div>
        <i className={index % 3 === 0 ? "blue" : index % 3 === 1 ? "green" : "amber"} aria-hidden="true" />
        <div className="today-detail">
          <div>
            <strong>{session.title}</strong>
            {current && <Badge tone="info">Now</Badge>}
            {session.status !== "approved" && (
              <Badge tone={session.status === "completed" ? "success" : "neutral"}>
                {session.status.replace("_", " ")}
              </Badge>
            )}
          </div>
          {note && <p>{note}</p>}
        </div>
        <Link href="/schedule" aria-label={`Open ${session.title} on the schedule`}>
          <ChevronRight size={18} aria-hidden="true" />
        </Link>
      </article>
    );
  };

  if (tasks.length === 0 && proposal.sessions.length === 0 && history.length === 0) {
    return (
      <>
        <PageHeading
          eyebrow="EMPTY WORKSPACE"
          title="Start with a clean plan."
          detail="There are no imported responsibilities, proposed sessions, or history yet. Add your responsibilities to build a plan."
        />
        <EmptyState
          illustration="route"
          title="Your workspace is clear"
          detail="Paste an assignment sheet, checklist, or email to see exactly what PlanPilot extracts and schedules."
          action={
            <Link href="/import" className="button button-primary button-md">
              <Plus size={16} aria-hidden="true" /> Add responsibilities
            </Link>
          }
        />
      </>
    );
  }
  return (
    <>
      <div className="dash-hero">
        <PageHeading
          eyebrow={formatToday(true).toUpperCase()}
          title="Your plan at a glance."
          actions={
            <Link href="/import" className="button button-primary button-md">
              <Plus size={16} aria-hidden="true" /> Add responsibilities
            </Link>
          }
        />
        <PlanOrbit
          compact
          progress={dayProgress}
          blocks={orbitBlocks}
          demoWhenEmpty={false}
          caption={
            orbitBlocks.length > 0
              ? `${todaySessions.length} ${todaySessions.length === 1 ? "session" : "sessions"} today · drag to spin`
              : "Nothing today · drag to spin"
          }
        />
      </div>
      <div className="dashboard-grid">
        <div className="dashboard-main">
          <PlanHealthPanel />
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Today’s plan</h2>
                <p>
                  {shownSessions.length === 0
                    ? "Nothing is scheduled for today."
                    : upcomingToday.length === 0
                      ? `All done · ${todayMinutes} min`
                      : `${minutesLeft} min left · ${upcomingToday.length} upcoming`}
                </p>
              </div>
              <Link href="/schedule">View week <ArrowRight size={15} aria-hidden="true" /></Link>
            </div>
            <div className="today-list">
              {shownSessions.length === 0 && (
                <p className="open-day">Nothing scheduled today.</p>
              )}
              {shownSessions.length > 0 && (
                <>
                  <h3 className="today-group-label">
                    <span>Upcoming</span>
                    <span>{upcomingToday.length}</span>
                  </h3>
                  {upcomingToday.length === 0 ? (
                    <p className="open-day today-group-empty">Nothing left for today.</p>
                  ) : (
                    upcomingToday.map(renderTodaySession)
                  )}
                </>
              )}
              {pastToday.length > 0 && (
                <>
                  <h3 className="today-group-label">
                    <span>Past</span>
                    <span>{pastToday.length}</span>
                  </h3>
                  {pastToday.map(renderTodaySession)}
                </>
              )}
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div><h2>Upcoming deadlines</h2></div>
              <Link href="/tasks/review">All tasks <ArrowRight size={15} aria-hidden="true" /></Link>
            </div>
            <div className="deadline-list">
              {upcomingDeadlines.length === 0 && (
                <p className="open-day">No dated deadlines yet.</p>
              )}
              {upcomingDeadlines.map((task) => (
                <article key={task.id}>
                  <div className="date-tile" aria-hidden="true">
                    <span>{shortDate(task.dueDate).split(" ")[0]}</span>
                    <strong>{shortDate(task.dueDate).split(" ")[1]}</strong>
                  </div>
                  <div>
                    <strong>{task.title}</strong>
                    <p>
                      <span className="sr-only">Due {shortDate(task.dueDate)}. </span>
                      {task.estimatedMinutes ? `${task.estimatedMinutes} min estimated` : "No estimate"} · {task.category}
                    </p>
                  </div>
                  <Badge tone={task.priority === "urgent" ? "danger" : task.priority === "high" ? "warning" : "neutral"}>{task.priority}</Badge>
                </article>
              ))}
            </div>
          </section>
        </div>
        <aside className="dashboard-side">
          {unscheduledMinutes > 0 && firstUnschedulable ? (
            <section className="risk-panel" aria-labelledby="risk-title">
              <span className="risk-icon"><AlertTriangle size={20} aria-hidden="true" /></span>
              <Badge tone="warning">Needs a decision</Badge>
              <h2 id="risk-title">{unscheduledMinutes} minutes do not fit yet</h2>
              <p>{firstUnschedulable.explanation}</p>
              {bestOption && (
                <div className="risk-option">
                  <span>Suggested next step</span>
                  <strong>{bestOption}</strong>
                  <small>{firstUnschedulable.title} · {firstUnschedulable.unscheduledMinutes} min unplaced</small>
                </div>
              )}
              <Link href="/schedule" className="button button-secondary button-md">
                Review options <ArrowRight size={15} aria-hidden="true" />
              </Link>
            </section>
          ) : (
            <section className="risk-panel risk-panel-clear" aria-labelledby="risk-title">
              <span className="risk-icon"><ShieldCheck size={20} aria-hidden="true" /></span>
              <Badge tone="success">All clear</Badge>
              <h2 id="risk-title">Nothing needs a decision</h2>
              <Link href="/schedule" className="button button-secondary button-md">
                Open schedule <ArrowRight size={15} aria-hidden="true" />
              </Link>
            </section>
          )}
          <section className="panel side-panel">
            <div className="panel-heading">
              <div><h2>Recent changes</h2></div>
            </div>
            <div className="mini-history">
              {history.length === 0 && <p className="open-day">No changes recorded yet.</p>}
              {history.slice(0, 3).map((item) => (
                <article key={item.id}>
                  <span><PencilLine size={15} aria-hidden="true" /></span>
                  <div><strong>{item.title}</strong><p>{item.at}</p></div>
                </article>
              ))}
            </div>
            <Link href="/changes" className="full-link">View change history <ArrowRight size={14} aria-hidden="true" /></Link>
          </section>
          <section className="completion-card">
            <span><CheckCircle2 size={20} aria-hidden="true" /></span>
            <div>
              <strong>
                {completedMinutes > 0
                  ? `${completedMinutes} min completed this week`
                  : "Nothing recorded this week"}
              </strong>
              <p>
                {completedMinutes > 0
                  ? `${weekReviews.length} ${weekReviews.length === 1 ? "session" : "sessions"} reviewed in the last 7 days.`
                  : "Mark sessions done in Daily review."}
              </p>
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}

function ImportView() {
  const {
    importText,
    setImportText,
    setImportDocumentSource,
    importState,
    extractionMode,
    extractionReport,
    importError,
    interpretationTrace,
    analyzeText,
    tasks,
    lastImportedTaskIds,
  } = usePlanPilot();
  const latestImportedIds = new Set(lastImportedTaskIds);
  const latestImportedTasks = tasks.filter(
    (task) => task.id && latestImportedIds.has(task.id),
  );
  const latestReviewCount = latestImportedTasks.filter(
    (task) => task.reviewRequired,
  ).length;
  const fallbackNotice = extractionFallbackNotice(extractionReport);
  const importWordCount = countImportWords(importText);
  const importIsOverLimit = importWordCount > MAX_AI_IMPORT_WORDS;
  const [tab, setTab] = useState<"paste" | "txt" | "document">("paste");
  const [documentBusy, setDocumentBusy] = useState(false);
  const [globalInstructions, setGlobalInstructions] = useState("");
  const [allowInlineGlobals, setAllowInlineGlobals] = useState(false);
  const detectedGlobals = prepareGlobalInstructions({ text: importText, globalInstructions,
    allowInlineGlobalInstructions: tab === "paste" && allowInlineGlobals,
    currentLocalDate: "", timeZone: "" }).rules;
  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.toLocaleLowerCase().endsWith(".txt")) {
      setImportText("");
      setImportDocumentSource(undefined);
      return;
    }
    setImportDocumentSource(undefined);
    setImportText(await file.text());
  };
  return (
    <>
      <PageHeading
        eyebrow="ADD RESPONSIBILITIES"
        title="Bring the mess. We’ll find the work."
        detail="PlanPilot separates actionable tasks from background information and preserves anything uncertain for review."
      />
      <div className="import-layout">
        <section className="panel import-panel">
          <div className="tab-list" role="tablist" aria-label="Import source">
            <button className={tab === "paste" ? "active" : ""} onClick={() => { setTab("paste"); setImportDocumentSource(undefined); }} role="tab" aria-selected={tab === "paste"}>
              <FileText size={16} aria-hidden="true" /> Paste text
            </button>
            <button className={tab === "txt" ? "active" : ""} onClick={() => { setTab("txt"); setImportDocumentSource(undefined); }} role="tab" aria-selected={tab === "txt"}>
              <Upload size={16} aria-hidden="true" /> TXT file
            </button>
            <button className={tab === "document" ? "active" : ""} onClick={() => setTab("document")} role="tab" aria-selected={tab === "document"}>
              <FileText size={16} aria-hidden="true" /> PDF or image
            </button>
          </div>
          {tab === "paste" ? (
            <label className="textarea-label">
              Source text
              <textarea
                value={importText}
                onChange={(event) => { setImportDocumentSource(undefined); setImportText(event.target.value); }}
                placeholder="Paste an assignment sheet, email, or checklist…"
              />
            </label>
          ) : tab === "txt" ? (
            <label className="file-drop">
              <Upload size={25} />
              <strong>Choose a TXT file</strong>
              <span>Plain text only · up to 100 KB</span>
              <input type="file" accept=".txt,text/plain" onChange={handleFile} />
            </label>
          ) : <><DocumentImport
            disabled={importState === "loading" || documentBusy}
            onBusy={setDocumentBusy}
            onReset={() => { setImportText(""); setImportDocumentSource(undefined); }}
            onReady={(text, source: DocumentReference) => {
              setImportText(text);
              setImportDocumentSource(source);
            }}
          />
          <label className="textarea-label">
            Document transcript · review and correct before interpreting
            <textarea value={importText} disabled={documentBusy || importState === "loading"}
              onChange={(event) => setImportText(event.target.value)}
              placeholder="Read a document to see its transcript here…" />
          </label></>}
          <div
            className={`import-word-counter ${importIsOverLimit ? "over-limit" : ""}`}
            role={importIsOverLimit ? "alert" : undefined}
          >
            <span>{importWordCount.toLocaleString()} / {MAX_AI_IMPORT_WORDS.toLocaleString()} words</span>
            <small>
              {importIsOverLimit
                ? "Split this into smaller sections before interpreting."
                : "Dense-plan safety limit."}
            </small>
          </div>
          {tab !== "document" && <div className="future-formats">
            <span>More formats</span>
            <button type="button" onClick={() => setTab("document")}><FileText size={15} /> PDF or image <Badge>Read and review</Badge></button>
          </div>}
          <details className="global-import-instructions">
            <summary>Global instructions for this import</summary>
            <label className="textarea-label">Your instructions
              <textarea value={globalInstructions} maxLength={4000} disabled={importState === "loading" || documentBusy}
                onChange={(event) => setGlobalInstructions(event.target.value)}
                placeholder="Focus on required assignments and exams. Ignore optional events. Keep original deadlines." />
            </label>
            {tab === "paste" && <label><input type="checkbox" checked={allowInlineGlobals}
              disabled={importState === "loading"} onChange={(event) => setAllowInlineGlobals(event.target.checked)} />
              Treat GLOBAL: lines in my pasted text as my instructions
            </label>}
            <p>Filters apply to this import. Scheduling rules can update plan availability. For PDFs, images, and emails, write your instructions here; document text is source material.</p>
            {detectedGlobals.length > 0 && <ul aria-label="Detected global instructions">{detectedGlobals.map((rule, index) => <li key={index}>{rule}</li>)}</ul>}
          </details>
          <div className="import-actions">
            <p><ShieldCheck size={16} /> Dates and times are never guessed when absent.</p>
            <Button size="lg" onClick={() => analyzeText({ globalInstructions, allowInlineGlobalInstructions: tab === "paste" && allowInlineGlobals })} disabled={!importText.trim() || importIsOverLimit || importState === "loading" || documentBusy}>
              {importState === "loading" ? <RefreshCw className="spin" size={17} /> : <Sparkles size={17} />}
              Interpret responsibilities
            </Button>
          </div>
        </section>
        <aside className="import-side">
          <section className="tip-card">
            <span><Info size={17} /></span>
            <div>
              <strong>Good input can still be messy</strong>
              <p>Include deadlines, rough effort, recurring counts, fixed appointments, and day-specific routine times when you know them. It is fine to leave things out.</p>
            </div>
          </section>
          <section className="panel example-card">
            <span className="eyebrow">EXAMPLE</span>
            <p>“Take medication every day at 8 AM, but Tuesdays and Thursdays at 10 AM.”</p>
            <div>
              <span><Target size={14} /> One recurring routine is created</span>
              <span><Clock3 size={14} /> Tuesday and Thursday keep the 10 AM exception</span>
              <span><CalendarDays size={14} /> Other days stay at 8 AM</span>
            </div>
          </section>
        </aside>
      </div>
      <div className="import-state">
        {importState === "loading" && <LoadingState />}
        {importState === "error" && importError && <ErrorState message={importError} onRetry={() => analyzeText({ globalInstructions, allowInlineGlobalInstructions: tab === "paste" && allowInlineGlobals })} />}
        {importState === "success" && (
          <div className="import-success-stack">
            {fallbackNotice && (
              <div className="state-card state-warning fallback-notice" role="alert">
                <AlertTriangle size={20} />
                <div>
                  <strong>{fallbackNotice.title}</strong>
                  <p>{fallbackNotice.detail}</p>
                  <p className="fallback-action">{fallbackNotice.action}</p>
                </div>
              </div>
            )}
            <div className="state-card state-success">
              <CheckCircle2 size={20} />
              <div>
                <strong>
                  {latestImportedTasks.length} {latestImportedTasks.length === 1 ? "responsibility" : "responsibilities"} interpreted this time
                </strong>
                <p>
                  {latestReviewCount > 0
                    ? `${latestReviewCount} need a quick review before scheduling. Confirm the highlighted dates, times, and other uncertain fields.`
                    : "Everything interpreted this time is ready to schedule."}
                </p>
                <p>{extractionModeImportSummary(extractionMode)}</p>
              </div>
              <Link className="button button-primary button-sm" href="/tasks/review">Review tasks <ArrowRight size={14} /></Link>
            </div>
            {interpretationTrace && (
              <section className="interpretation-stages" aria-label="Interpretation stages">
                <div>
                  <span>1</span>
                  <p><strong>Discovered work</strong>{interpretationTrace.discoveredResponsibilityCount} exact source {interpretationTrace.discoveredResponsibilityCount === 1 ? "span" : "spans"}</p>
                </div>
                <ArrowRight size={14} />
                <div>
                  <span>2</span>
                  <p><strong>Attached facts</strong>{interpretationTrace.explicitFieldCount} supplied · {interpretationTrace.derivedFieldCount} resolved</p>
                </div>
                <ArrowRight size={14} />
                <div>
                  <span>3</span>
                  <p><strong>Added suggestions</strong>{interpretationTrace.inferredFieldCount} planning-only fields</p>
                </div>
                {interpretationTrace.globalInstructions.length > 0 && (
                  <details>
                    <summary>{interpretationTrace.globalInstructions.length} global {interpretationTrace.globalInstructions.length === 1 ? "instruction" : "instructions"} sent to the interpreter</summary>
                    <ul>{interpretationTrace.globalInstructions.map((span, index) => <li key={index}>{span.quote}</li>)}</ul>
                  </details>
                )}
                {interpretationTrace.validationWarnings.length > 0 && (
                  <Badge tone="warning">
                    {interpretationTrace.validationWarnings.length} validation {interpretationTrace.validationWarnings.length === 1 ? "note" : "notes"}
                  </Badge>
                )}
              </section>
            )}
          </div>
        )}
      </div>
    </>
  );
}

export function TaskReviewCard({ task }: { task: ExtractedTask }) {
  const { tasks = [], updateTask, approveTask, deleteTask } = usePlanPilot();
  const linkedTiming = task.schedulingConstraints?.linkedTiming;
  const calculatedTiming = task.schedulingConstraints?.calculatedTiming;
  const arrivalBuffer = arrivalBufferReservations(tasks, true).find((item) => item.taskId === task.id);
  const [expanded, setExpanded] = useState(task.reviewRequired ?? false);
  const [addingTimeFor, setAddingTimeFor] = useState<DayOfWeek>();
  const visibleMissingInformation = task.missingInformation.filter(
    (item) => !/^choose (?:a )?(?:plan )?start date$/i.test(item.trim()),
  );
  const preferredDateSummary = preferredDateWindowSummary(task);
  const relationshipDetails = task.fieldProvenance?.filter((field) => field.path.startsWith("relationships.")) ?? [];
  const hasDeadline = Boolean(task.dueDate || task.dueTime || task.dueWindow);
  const timingSummary = taskTimingSummary(
    task,
    hasDeadline || !preferredDateSummary,
  );
  const effortIsPlanningEstimate =
    task.effortEstimateSource === "ai" ||
    task.effortEstimateSource === "heuristic" ||
    taskFieldOrigin(task, "estimatedMinutes") === "inferred";
  const schedulingPreference = taskSchedulingPreference(task);
  const customPreferenceWindow =
    task.schedulingConstraints?.preferredTimeWindows?.[0] ?? {
      start: "09:00",
      end: "17:00",
    };
  const interpretedRequiredWindow =
    task.schedulingConstraints?.allowedTimeWindows
      ?.map(
        (window) =>
          `${formatClockTime(window.start)}–${formatClockTime(window.end)}`,
      )
      .join(", ");
  const updateFixedStartAt = (value: string) => {
    if (!value) {
      updateTask(task.id ?? "", {
        fixedStartAt: undefined,
        fixedEndAt: undefined,
      });
      return;
    }

    const fixedStartAt = fromZonedTime(
      value,
      DEFAULT_PREFERENCES.timeZone,
    ).toISOString();
    let fixedEndAt = task.fixedEndAt;
    if (task.fixedStartAt && task.fixedEndAt) {
      const duration =
        new Date(task.fixedEndAt).getTime() -
        new Date(task.fixedStartAt).getTime();
      if (duration > 0) {
        fixedEndAt = new Date(
          new Date(fixedStartAt).getTime() + duration,
        ).toISOString();
      }
    } else if (
      fixedEndAt &&
      new Date(fixedEndAt).getTime() <= new Date(fixedStartAt).getTime()
    ) {
      fixedEndAt = undefined;
    }
    updateTask(task.id ?? "", {
      fixedStartAt,
      fixedEndAt,
      dueDate: undefined,
      dueTime: undefined,
      dueAt: undefined,
      dueWindow: undefined,
    });
  };
  const updateFixedEndAt = (value: string) => {
    if (!value) {
      updateTask(task.id ?? "", { fixedEndAt: undefined });
      return;
    }

    const fixedEndAt = fromZonedTime(
      value,
      DEFAULT_PREFERENCES.timeZone,
    ).toISOString();
    if (
      task.fixedStartAt &&
      new Date(fixedEndAt).getTime() <= new Date(task.fixedStartAt).getTime()
    ) {
      return;
    }
    updateTask(task.id ?? "", { fixedEndAt });
  };
  const saveRecurringSchedules = (
    schedules: Partial<Record<DayOfWeek, string[]>>,
  ) => {
    if (task.recurrence?.mode !== "fixed_times") return;
    const timeRules = groupRecurrenceDaySchedules(schedules);
    if (timeRules.length === 0) return;
    updateTask(task.id ?? "", {
      recurrence: {
        ...task.recurrence,
        daysOfWeek: DAYS_OF_WEEK.filter(
          (item) => (schedules[item]?.length ?? 0) > 0,
        ),
        timeRules,
      },
    });
  };
  const daySchedules = () =>
    Object.fromEntries(
      DAYS_OF_WEEK.map((day) => [
        day,
        recurrenceTimesForDay(task.recurrence, day),
      ]),
    ) as Record<DayOfWeek, string[]>;
  const updateRecurringTime = (
    day: DayOfWeek,
    previousTime: string,
    nextTime: string,
  ) => {
    const schedules = daySchedules();
    schedules[day] = [
      ...new Set(
        schedules[day]
          .map((time) => (time === previousTime ? nextTime : time))
          .filter(Boolean),
      ),
    ].sort();
    saveRecurringSchedules(schedules);
  };
  const addRecurringTime = (day: DayOfWeek, time: string) => {
    if (!time) return;
    const schedules = daySchedules();
    schedules[day] = [...new Set([...schedules[day], time])].sort();
    saveRecurringSchedules(schedules);
    setAddingTimeFor(undefined);
  };
  return (
    <article className={`task-review-card ${task.reviewRequired ? "needs-review" : ""}`}>
      <div className="task-card-top">
        <div className="task-check">
          {task.approved ? <Check size={15} /> : <AlertTriangle size={15} />}
        </div>
        <div className="task-title-wrap">
          <div className="task-status-line">
            <Badge tone={task.reviewRequired ? "warning" : "success"}>
              {task.reviewRequired ? "Review needed" : "Ready to schedule"}
            </Badge>
            <Badge>{task.taskType.replace("_", " ")}</Badge>
            {linkedTiming && <Badge>Calculated · linked</Badge>}
            {calculatedTiming && <Badge>Calculated · independent</Badge>}
            {(linkedTiming?.approximate || calculatedTiming?.approximate) && <Badge>Estimated timing</Badge>}
          </div>
          <input
            className="task-title-input"
            value={task.title}
            aria-label="Task title"
            onChange={(event) => updateTask(task.id ?? "", { title: event.target.value })}
          />
          <FieldConfidenceIndicator label="Title" confidence={task.fieldConfidence.title} />
          <FieldOriginBadge task={task} path="title" />
        </div>
        <button className="icon-button" onClick={() => setExpanded(!expanded)} aria-label={expanded ? "Collapse task" : "Edit task"}>
          <PencilLine size={17} />
        </button>
        <button className="icon-button" onClick={() => deleteTask(task.id ?? "")} aria-label={`Delete ${task.title}`}>
          <Trash2 size={17} />
        </button>
      </div>
      <div className="source-quote">
        <span>
          {task.sourceSpan
            ? `Exact source · characters ${task.sourceSpan.start}–${task.sourceSpan.end}`
            : "From your source"}
        </span>
        <p>“{task.sourceSpan?.quote ?? task.sourceText}”</p>
        {task.dependencies?.length ? (
          <small>
            {task.dependencies
              .map((dependency) =>
                dependency.relation === "before"
                  ? "Must come before related work"
                  : "Follows related work",
              )
              .join(" · ")}
          </small>
        ) : null}
      </div>
      {task.sourceDocument && <TaskDocumentSource source={task.sourceDocument} />}
      {relationshipDetails.length > 0 && (
        <div className="source-quote" aria-label="Relationship interpretation">
          <span>{task.reviewRequired ? "AI interpretation · needs review" : "Relationship interpretation"}</span>
          {relationshipDetails.map((field, index) => (
            <div key={`${field.path}-${index}`}>
              <p>{field.rationale}</p>
              {field.evidence?.map((span) => <small key={`${span.start}-${span.end}`}>Source: “{span.quote}”</small>)}
            </div>
          ))}
          <small>Quote presence and arithmetic are checked. Confirm that the AI connected the right activities and interpreted the timing correctly.</small>
        </div>
      )}
      {linkedTiming && (
        <p className="source-quote">Updates with the related event. Editing this card’s date/time makes it independent.</p>
      )}
      {calculatedTiming && (
        <p className="source-quote">AI interpreted the relationship; the calculator filled in these times without relationship validation. This is an independent task. Changes to other events will not move it.</p>
      )}
      {visibleMissingInformation.length > 0 && (
        <div className="review-focus" role="note">
          <AlertTriangle size={15} />
          <div>
            <strong>Check before scheduling</strong>
            <div className="missing-row">
              {visibleMissingInformation.map((item) => (
                <Badge tone="warning" key={item}>{item}</Badge>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="task-field-summary">
        {task.taskType === "fixed_time" ? (
          <div>
            <span>{task.reviewRequired ? "Proposed event time" : "Scheduled event"}</span>
            <strong>{fixedTimeSummary(task)}</strong>
            <FieldOriginBadge task={task} path="fixedStartAt" />
            <FieldOriginBadge task={task} path="fixedEndAt" />
          </div>
        ) : task.recurrence?.mode === "fixed_times" ? (
          <div>
            <span>Recurring schedule</span>
            <strong>{recurrenceSummary(task)}</strong>
            <FieldConfidenceIndicator label="Recurrence" confidence={task.fieldConfidence.recurrence} />
            <FieldOriginBadge task={task} path="recurrence" />
          </div>
        ) : hasDeadline ? (
          <div>
            <span>{task.responsibilityKind === "milestone" ? (task.reviewRequired ? "Proposed checkpoint" : "Checkpoint") : "Deadline"}</span>
            <strong>
              {task.dueWindow
                ? `${shortDate(
                    task.dueDate ?? localDateKey(new Date(task.dueWindow.start)),
                  )} · ${task.dueWindow.label}`
                : task.dueDate
                  ? `${shortDate(task.dueDate)}${task.dueTime ? ` at ${formatClockTime(task.dueTime)}` : " · time not specified"}`
                  : task.dueTime
                    ? `${formatClockTime(task.dueTime)} · date needs confirmation`
                    : "Not specified"}
            </strong>
            <FieldConfidenceIndicator label="Deadline" confidence={task.fieldConfidence.dueDate} />
            <FieldOriginBadge task={task} path="dueDate" />
            {task.dueTime && <FieldOriginBadge task={task} path="dueTime" />}
            {task.dueWindow && <FieldOriginBadge task={task} path="dueWindow" />}
          </div>
        ) : preferredDateSummary ? (
          <div>
            <span>{relationshipDetails.length ? "Calculated start and finish (suggested)" : "Preferred work time"}</span>
            <strong>{preferredDateSummary}</strong>
            <FieldOriginBadge
              task={task}
              path="schedulingConstraints.preferredDateWindows"
            />
          </div>
        ) : task.occurrenceWindow ? (
          <div>
            <span>Event date · time needs review</span>
            <strong>{formatDay(task.occurrenceWindow.start, true)} · {task.occurrenceWindow.label}</strong>
          </div>
        ) : (
          <div>
            <span>No deadline</span>
            <strong>Not specified</strong>
          </div>
        )}
        {arrivalBuffer && (
          <div><span>Reserved arrival buffer · not active work</span><strong>{datedIntervalSummary(arrivalBuffer.start, arrivalBuffer.end)}</strong></div>
        )}
        <div
          className={effortIsPlanningEstimate ? "task-field-secondary" : undefined}
          title={
            effortIsPlanningEstimate
              ? "This is a planning suggestion, not a duration supplied in the source."
              : undefined
          }
        >
          <span>{effortIsPlanningEstimate ? "Suggested duration" : "Duration"}</span>
          <strong>{task.responsibilityKind === "milestone" ? "Checkpoint · no active work" : task.estimatedMinutes ? `${task.estimatedMinutes} minutes` : "Not estimated"}</strong>
          <FieldOriginBadge task={task} path="estimatedMinutes" />
        </div>
        <div>
          <span>Priority</span>
          <strong className="capitalize">{task.priority}</strong>
          <FieldConfidenceIndicator label="Priority" confidence={task.fieldConfidence.priority} />
          <FieldOriginBadge task={task} path="priority" />
        </div>
        <div>
          <span>Energy</span>
          <strong className="capitalize">{task.energyDemand}</strong>
          <FieldOriginBadge task={task} path="energyDemand" />
        </div>
        {timingSummary && (
          <div>
            <span>Scheduling</span>
            <strong>{timingSummary}</strong>
            {task.schedulingConstraints?.preferredDateWindows?.length ? (
              <FieldOriginBadge
                task={task}
                path="schedulingConstraints.preferredDateWindows"
              />
            ) : (
              <FieldOriginBadge task={task} path="schedulingConstraints" />
            )}
          </div>
        )}
      </div>
      <div className="task-preference-editor">
        <label>
          {preferredDateSummary
            ? "Additional time-of-day preference"
            : "Scheduling preference"} <span>(optional)</span>
          <select
            aria-label={`Scheduling preference for ${task.title}`}
            disabled={schedulingPreference === "fixed"}
            value={schedulingPreference}
            onChange={(event) => {
              if (
                event.target.value === "fixed" ||
                event.target.value === "interpreted_required"
              ) {
                return;
              }
              updateTask(task.id ?? "", {
                schedulingConstraints: setTaskSchedulingPreference(
                  task,
                  event.target.value as TaskSchedulingPreference,
                ),
              });
            }}
          >
            {schedulingPreference === "fixed" && (
              <option value="fixed">Fixed by event schedule</option>
            )}
            {schedulingPreference === "interpreted_required" && (
              <option value="interpreted_required">
                Only {interpretedRequiredWindow} (interpreted from source)
              </option>
            )}
            {TASK_SCHEDULING_PREFERENCE_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.value === "none" && preferredDateSummary
                  ? `Keep ${preferredDateSummary}`
                  : option.label}
              </option>
            ))}
          </select>
        </label>
        {schedulingPreference === "custom" && (
          <div className="task-custom-time-window">
            <label>
              From
              <input
                type="time"
                value={customPreferenceWindow.start}
                aria-label={`Preferred start time for ${task.title}`}
                onChange={(event) =>
                  updateTask(task.id ?? "", {
                    schedulingConstraints: setCustomTaskSchedulingWindow(task, {
                      ...customPreferenceWindow,
                      start: event.target.value,
                    }),
                  })
                }
              />
            </label>
            <label>
              To
              <input
                type="time"
                value={customPreferenceWindow.end}
                aria-label={`Preferred end time for ${task.title}`}
                onChange={(event) =>
                  updateTask(task.id ?? "", {
                    schedulingConstraints: setCustomTaskSchedulingWindow(task, {
                      ...customPreferenceWindow,
                      end: event.target.value,
                    }),
                  })
                }
              />
            </label>
          </div>
        )}
        <p>
          {schedulingPreference === "fixed"
            ? (task.reviewRequired ? "This activity has a proposed fixed time; confirm it before scheduling." : "This activity has a fixed scheduled time.")
            : schedulingPreference === "interpreted_required"
              ? "This required window came from the source. Choosing another option adds a soft preference without removing it."
              : "A soft preference: deadlines and hard availability still come first."}
        </p>
      </div>
      {task.dueWindow ? (
        <div className="assumption-note">
          <Info size={15} />
          <span>
            <strong>Named-period deadline:</strong> no exact clock time was
            stated. Planning conservatively finishes by the start of {task.dueWindow.label}.
          </span>
        </div>
      ) : task.dueDate && !task.dueTime ? (
        <div className="assumption-note">
          <Info size={15} />
          <span><strong>Planning assumption only:</strong> feasibility uses the end of your waking day. No due time will be saved.</span>
        </div>
      ) : null}
      {expanded && (
        <div className="task-edit-grid">
          <label>
            Task type
            <select
              value={task.taskType}
              onChange={(event) => {
                const taskType = event.target.value as ExtractedTask["taskType"];
                const otherConstraints = { ...task.schedulingConstraints };
                delete otherConstraints.preferredDateWindows;
                updateTask(
                  task.id ?? "",
                  taskType === "fixed_time"
                    ? {
                        taskType,
                        recurrence: undefined,
                        dueDate: undefined,
                        dueTime: undefined,
                        dueAt: undefined,
                        dueWindow: undefined,
                        schedulingConstraints:
                          Object.keys(otherConstraints).length > 0
                            ? otherConstraints
                            : undefined,
                      }
                    : {
                        taskType,
                        recurrence:
                          taskType === "recurring_goal"
                            ? task.recurrence
                            : undefined,
                        fixedStartAt: undefined,
                        fixedEndAt: undefined,
                      },
                );
              }}
            >
              <option value="flexible">Flexible work</option>
              <option value="fixed_time">Fixed-time event</option>
              <option value="recurring_goal">Recurring routine or quota</option>
            </select>
          </label>
          {task.taskType === "recurring_goal" && task.recurrence?.mode !== "fixed_times" && (
            <label>
              Occurrences
              <input
                type="number"
                min={1}
                max={31}
                value={task.recurrence?.count ?? 1}
                onChange={(event) =>
                  updateTask(task.id ?? "", {
                    recurrence: {
                      frequency: task.recurrence?.frequency ?? "weekly",
                      ...task.recurrence,
                      mode: "quota",
                      count: Number(event.target.value) || 1,
                      timeRules: undefined,
                    },
                  })
                }
              />
            </label>
          )}
          {task.taskType === "fixed_time" ? (
            <>
              <label>
                Fixed start
                <input
                  type="datetime-local"
                  value={localDateTimeValue(task.fixedStartAt)}
                  onChange={(event) => updateFixedStartAt(event.target.value)}
                />
              </label>
              <label>
                Fixed end
                <input
                  type="datetime-local"
                  min={localDateTimeValue(task.fixedStartAt) || undefined}
                  value={localDateTimeValue(task.fixedEndAt)}
                  onChange={(event) => updateFixedEndAt(event.target.value)}
                />
              </label>
            </>
          ) : (
            <>
              <label>
                Due date
                <input
                  type="date"
                  value={task.dueDate ?? ""}
                  onChange={(event) => {
                    const dueDate = event.target.value;
                    updateTask(
                      task.id ?? "",
                      dueDate
                        ? {
                            ...deadlineUpdateFields(
                              { dueDate, dueTime: task.dueTime },
                              DEFAULT_PREFERENCES.timeZone,
                            ),
                            dueWindow: undefined,
                          }
                        : {
                            dueDate: undefined,
                            dueTime: undefined,
                            dueAt: undefined,
                            dueWindow: undefined,
                          },
                    );
                  }}
                />
              </label>
              <label>
                Due time
                <input
                  type="time"
                  value={task.dueTime ?? ""}
                  disabled={!task.dueDate}
                  onChange={(event) => {
                    if (!task.dueDate) return;
                    updateTask(
                      task.id ?? "",
                      {
                        ...deadlineUpdateFields(
                          {
                            dueDate: task.dueDate,
                            dueTime: event.target.value || undefined,
                          },
                          DEFAULT_PREFERENCES.timeZone,
                        ),
                        dueWindow: undefined,
                      },
                    );
                  }}
                />
              </label>
            </>
          )}
          <label>
            Estimated minutes
            <input type="number" min={1} max={1440} value={task.estimatedMinutes ?? ""} onChange={(event) => updateTask(task.id ?? "", { estimatedMinutes: Number(event.target.value) || undefined })} />
          </label>
          <label>
            Priority
            <select value={task.priority} onChange={(event) => updateTask(task.id ?? "", { priority: event.target.value as ExtractedTask["priority"] })}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option>
            </select>
          </label>
          <label>
            Category
            <select value={task.category} onChange={(event) => updateTask(task.id ?? "", { category: event.target.value as ExtractedTask["category"] })}>
              {["school", "work", "health", "fitness", "errand", "personal", "other"].map((value) => <option key={value}>{value}</option>)}
            </select>
          </label>
          <label>
            Energy demand
            <select value={task.energyDemand} onChange={(event) => updateTask(task.id ?? "", { energyDemand: event.target.value as ExtractedTask["energyDemand"] })}>
              <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
            </select>
          </label>
          <label className="check-field">
            <input type="checkbox" checked={task.splittable} onChange={(event) => updateTask(task.id ?? "", { splittable: event.target.checked })} />
            May be split into sessions
          </label>
          {task.recurrence?.mode === "fixed_times" && task.recurrence.frequency !== "monthly" && (
            <fieldset className="recurrence-time-editor">
              <legend>Fixed recurring times</legend>
              <p>Days can be off, use a different time, or contain multiple occurrences.</p>
              <div className="recurrence-day-grid">
                {DAYS_OF_WEEK.map((day) => {
                  const times = recurrenceTimesForDay(task.recurrence, day);
                  const totalTimes = task.recurrence?.timeRules?.reduce(
                    (total, rule) => total + rule.daysOfWeek.length,
                    0,
                  ) ?? 0;
                  return (
                    <div className="recurrence-day-row" key={day}>
                      <strong>{SHORT_DAY_LABELS[day]}</strong>
                      <div>
                        {times.length === 0 && addingTimeFor !== day && (
                          <span className="recurrence-off">Off</span>
                        )}
                        {times.map((time) => (
                          <span className="recurrence-time-control" key={time}>
                            <input
                              type="time"
                              value={time}
                              aria-label={`${day} recurring time`}
                              onChange={(event) =>
                                updateRecurringTime(day, time, event.target.value)
                              }
                            />
                            <button
                              type="button"
                              disabled={totalTimes <= 1}
                              aria-label={`Remove ${formatClockTime(time)} on ${day}`}
                              onClick={() => updateRecurringTime(day, time, "")}
                            >
                              <X size={12} />
                            </button>
                          </span>
                        ))}
                        {addingTimeFor === day ? (
                          <input
                            type="time"
                            value=""
                            autoFocus
                            aria-label={`Add another ${day} time`}
                            onBlur={() => setAddingTimeFor(undefined)}
                            onChange={(event) =>
                              addRecurringTime(day, event.target.value)
                            }
                          />
                        ) : (
                          <button
                            type="button"
                            className="recurrence-add-time"
                            onClick={() => setAddingTimeFor(day)}
                          >
                            <Plus size={12} /> Time
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </fieldset>
          )}
          {task.recurrence?.mode === "fixed_times" && task.recurrence.frequency === "monthly" && (
            <fieldset className="recurrence-time-editor recurrence-monthly-editor">
              <legend>Monthly recurring pattern</legend>
              <p>{recurrenceSummary(task)}</p>
              <span>To change the ordinal or date pattern, update the source wording and interpret it again.</span>
            </fieldset>
          )}
          {task.recurrence?.dateOverrides?.length ? (
            <fieldset className="recurrence-time-editor recurrence-exception-list">
              <legend>One-date exceptions</legend>
              <ul>
                {task.recurrence.dateOverrides.map((override) => (
                  <li key={override.date}>
                    <strong>{shortDate(override.date)}</strong>
                    <span>
                      {override.skip
                        ? "Skipped"
                        : override.times?.map(formatClockTime).join(" and ")}
                    </span>
                  </li>
                ))}
              </ul>
            </fieldset>
          ) : null}
        </div>
      )}
      <div className="task-card-actions">
        <button onClick={() => setExpanded(!expanded)}>{expanded ? "Done editing" : "Edit all fields"}</button>
        {!task.approved && (
          <Button size="sm" onClick={() => approveTask(task.id ?? "")}>
            <Check size={14} /> Approve task
          </Button>
        )}
      </div>
    </article>
  );
}

function planDateLabel(value?: string | null): string {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T12:00:00Z`));
}

function SequencePlanControl({ planTasks }: { planTasks: ExtractedTask[] }) {
  const { setSequenceStartDate } = usePlanPilot();
  const sequences = planTasks
    .map((task) => taskSequence(task))
    .filter((sequence) => sequence !== undefined);
  const groupId = sequences[0]?.groupId;
  const anchors = [...new Set(sequences.map((sequence) => sequence.anchorDate).filter(Boolean))];
  const anchorDate = anchors.length === 1 ? anchors[0] : undefined;
  const maxWeek = Math.max(0, ...sequences.map((sequence) => sequence.week ?? 0));
  const [command, setCommand] = useState("");
  const [preview, setPreview] = useState<PlanAdjustmentPreview>();

  if (!groupId) return null;

  const buildPreview = () => {
    setPreview(
      previewPlanAdjustment({
        command,
        tasks: planTasks,
        currentLocalDate: localDateKey(),
        timeZone: DEFAULT_PREFERENCES.timeZone,
      }),
    );
  };
  const applyPreview = () => {
    if (!preview?.ok || !preview.groupId || !preview.newAnchor) return;
    setSequenceStartDate(preview.groupId, preview.newAnchor);
    setCommand("");
    setPreview(undefined);
  };

  return (
    <section className={`sequence-plan-panel ${anchorDate ? "" : "needs-start"}`}>
      <div className="sequence-plan-heading">
        <span className="sequence-plan-icon"><Waypoints size={18} /></span>
        <div>
          <strong>{maxWeek > 0 ? `${maxWeek}-week plan` : "Structured plan"}</strong>
          <p>{planTasks.length} linked responsibilities · one shared start date</p>
        </div>
        <Badge tone={anchorDate ? "success" : "warning"}>
          {anchorDate ? "Start resolved" : "Start needed"}
        </Badge>
      </div>
      <div className="sequence-start-row">
        <label>
          Plan start · Week 1, Day 1
          <input
            type="date"
            value={anchorDate ?? ""}
            onChange={(event) => {
              setPreview(undefined);
              setSequenceStartDate(groupId, event.target.value || undefined);
            }}
          />
        </label>
        <div>
          <strong>{planDateLabel(anchorDate)}</strong>
          <p>
            {anchorDate
              ? "Every Week/Day item moves together from this anchor."
              : "Choose this once; you do not need to edit each responsibility."}
          </p>
          <FieldOriginBadge task={planTasks[0]} path="sequence.anchorDate" />
        </div>
      </div>
      <div className="plan-adjuster">
        <div>
          <span><Sparkles size={15} /></span>
          <div>
            <strong>Adjust this plan</strong>
            <p>Describe one date change. Nothing moves until you preview and apply it.</p>
          </div>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            buildPreview();
          }}
        >
          <input
            value={command}
            onChange={(event) => {
              setCommand(event.target.value);
              setPreview(undefined);
            }}
            placeholder='Try “Shift this plan down one day”'
            aria-label="Plan adjustment request"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={!command.trim()}>
            Preview
          </Button>
        </form>
        {preview && (
          preview.ok ? (
            <div className="plan-adjustment-preview" role="status">
              <div>
                <span>Preview</span>
                <strong>{planDateLabel(preview.oldAnchor)} <ArrowRight size={13} /> {planDateLabel(preview.newAnchor)}</strong>
                <p>{preview.affectedTaskCount} linked responsibilities will move together.</p>
              </div>
              <Button size="sm" onClick={applyPreview}>Apply change</Button>
            </div>
          ) : (
            <div className="plan-adjustment-error" role="alert">
              <AlertTriangle size={14} /> {preview.errors[0]?.message}
            </div>
          )
        )}
      </div>
    </section>
  );
}

function ReviewView() {
  const { tasks, approveTask, deleteTasks, lastImportedTaskIds, planningRules } = usePlanPilot();
  const latestIds = new Set(lastImportedTaskIds);
  const latestTasks = tasks.filter((task) => task.id && latestIds.has(task.id));
  const [filter, setFilter] = useState<"recent" | "review" | "ready" | "all">(
    latestTasks.length > 0 ? "recent" : "review",
  );
  const shown = tasks.filter((task) =>
    filter === "recent"
      ? !!task.id && latestIds.has(task.id)
      : filter === "all"
        ? true
        : filter === "review"
          ? task.reviewRequired
          : !task.reviewRequired,
  );
  const scopedTasks = filter === "recent" ? latestTasks : tasks;
  const reviewCount = scopedTasks.filter((task) => task.reviewRequired).length;
  const approvableReviewTasks = scopedTasks.filter((task) => {
    if (!task.reviewRequired) return false;
    const sequence = taskSequence(task);
    return !sequence || Boolean(sequence.anchorDate);
  });
  const allReviewCount = tasks.filter((task) => task.reviewRequired).length;
  const sequencePlanGroups = [
    ...(filter === "recent" ? latestTasks : shown).reduce(
      (groups, task) => {
        const sequence = taskSequence(task);
        if (!sequence) return groups;
        const group = groups.get(sequence.groupId) ?? [];
        group.push(task);
        groups.set(sequence.groupId, group);
        return groups;
      },
      new Map<string, ExtractedTask[]>(),
    ).values(),
  ];
  const clearLabel =
    filter === "recent"
      ? "Just added"
      : filter === "review"
        ? "Needs review"
        : filter === "ready"
          ? "Ready"
          : "All tasks";
  const clearShownTasks = () => {
    const ids = shown
      .map((task) => task.id)
      .filter((id): id is string => !!id);
    if (ids.length === 0) return;
    if (
      window.confirm(
        `Remove ${ids.length} ${ids.length === 1 ? "task" : "tasks"} from ${clearLabel}? This also removes their scheduled sessions. You can undo this from Schedule.`,
      )
    ) {
      deleteTasks(ids);
      if (filter === "recent") setFilter("review");
    }
  };
  if (tasks.length === 0) {
    return (
      <>
        <PageHeading
          eyebrow="REVIEW INTERPRETATION"
          title="No tasks to review yet."
          detail="Import your own responsibilities first. PlanPilot will preserve the source text and flag uncertain fields here."
        />
        <EmptyState
          illustration="inbox"
          title="The review queue is empty"
          detail="Add pasted text or a TXT file to test task extraction and field-level confidence."
          action={
            <Link href="/import" className="button button-primary button-md">
              <Plus size={16} /> Import responsibilities
            </Link>
          }
        />
      </>
    );
  }
  return (
    <>
      <PageHeading
        eyebrow="REVIEW INTERPRETATION"
        title={filter === "recent" ? "Review what you just added." : "Check what PlanPilot understood."}
        detail={
          filter === "recent"
            ? "Older responsibilities remain protected in the plan but stay out of this latest-import view."
            : "Low-confidence fields are marked individually. The source stays beside each interpretation."
        }
        actions={
          <Button
            onClick={() => approvableReviewTasks.forEach((task) => approveTask(task.id ?? ""))}
            disabled={approvableReviewTasks.length === 0}
          >
            <Check size={16} /> Approve reviewed tasks
          </Button>
        }
      />
      <div className="review-summary">
        <div><strong>{scopedTasks.length}</strong><span>{filter === "recent" ? "Just added" : "Tasks found"}</span></div>
        <div><strong>{reviewCount}</strong><span>Need review</span></div>
        <div><strong>{scopedTasks.filter((task) => !task.reviewRequired).length}</strong><span>Ready</span></div>
        <div className="confidence-legend">
          <span><i className="high" /> High confidence</span>
          <span><i className="medium" /> Check context</span>
          <span><i className="low" /> Review field</span>
        </div>
      </div>
      {sequencePlanGroups.length > 0 && (
        <div className="sequence-plan-list">
          {sequencePlanGroups.map((planTasks) => (
            <SequencePlanControl
              key={taskSequence(planTasks[0])?.groupId}
              planTasks={planTasks}
            />
          ))}
        </div>
      )}
      {(planningRules.earliestWorkTime ||
        planningRules.latestWorkTime ||
        planningRules.blockedTimes?.length) && (
        <div className="assumption-note">
          <Clock3 size={15} />
          <span>
            <strong>Schedule rules understood:</strong>{" "}
            {planningRules.earliestWorkTime
              ? `work starts at ${formatClockTime(planningRules.earliestWorkTime)}`
              : "default start time"}
            {planningRules.latestWorkTime
              ? ` and ends at ${formatClockTime(planningRules.latestWorkTime)}`
              : ""}
            {planningRules.blockedTimes?.length
              ? `; ${planningRules.blockedTimes.length} protected ${planningRules.blockedTimes.length === 1 ? "period" : "periods"}`
              : ""}
            .
          </span>
        </div>
      )}
      <div className="filter-tabs-row">
        <div className="filter-tabs" role="group" aria-label="Task filter">
          {([...(latestTasks.length > 0 ? ["recent" as const] : []), "review", "ready", "all"] as const).map((item) => (
            <button key={item} aria-pressed={filter === item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>
              {item === "recent"
                ? `Just added (${latestTasks.length})`
                : item === "review"
                  ? `Needs review (${allReviewCount})`
                  : item === "ready"
                    ? `Ready (${tasks.length - allReviewCount})`
                    : `All (${tasks.length})`}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="filter-clear"
          onClick={clearShownTasks}
          disabled={shown.length === 0}
          aria-label={`Clear ${clearLabel}`}
        >
          <Trash2 size={14} /> Clear {clearLabel}
        </button>
      </div>
      <div className="review-list">
        {shown.length ? shown.map((task) => <TaskReviewCard task={task} key={task.id} />) : (
          <EmptyState title="Nothing in this group" detail="Choose another filter or import more responsibilities." />
        )}
      </div>
      <div className="sticky-review-action">
        <div><strong>{scopedTasks.length - reviewCount} of {scopedTasks.length} {filter === "recent" ? "new tasks" : "tasks"} ready</strong><span>{filter === "recent" ? "Existing responsibilities stay protected in the updated schedule." : "Unresolved fixed events will stay off the schedule."}</span></div>
        <Link className="button button-primary button-md" href="/schedule">
          {filter === "recent" ? "View updated schedule" : "Build proposed schedule"} <ArrowRight size={16} />
        </Link>
      </div>
    </>
  );
}

export function UnschedulableTaskCard({ task, responsibility }: { task: UnschedulableTask; responsibility?: ExtractedTask }) {
  const timing = responsibility && (
    responsibility.fixedStartAt ? fixedTimeSummary(responsibility)
      : preferredDateWindowSummary(responsibility)
        ?? (responsibility.dueAt ? `${formatDay(responsibility.dueAt, true)} at ${formatTime(responsibility.dueAt)}`
          : responsibility.occurrenceWindow ? `${formatDay(responsibility.occurrenceWindow.start, true)} · ${responsibility.occurrenceWindow.label}` : undefined)
  );
  return (
    <article className="unschedulable-card">
      <span><AlertTriangle size={18} /></span>
      <div>
        <div><strong>{task.title}</strong><Badge tone="warning">{task.unscheduledMinutes} min unplaced</Badge></div>
        <p>{task.explanation}</p>
        {timing && <p><strong>{responsibility?.reviewRequired ? "Proposed timing (needs review): " : "Task timing: "}</strong>{timing}</p>}
        {responsibility?.reviewRequired && <Link href="/tasks/review">Review task timing <ArrowRight size={14} /></Link>}
        <ul>{task.suggestedActions.slice(0, 2).map((action) => <li key={action}>{action}</li>)}</ul>
      </div>
    </article>
  );
}

export function ScheduleSessionCard({
  session,
  selectable = true,
  reasonExpanded,
  onReasonExpandedChange,
  onMove,
  onSessionPointerDown,
  onSessionPointerMove,
  onSessionPointerUp,
  onSessionPointerCancel,
  onSessionLostPointerCapture,
}: {
  session: PlannedSession;
  selectable?: boolean;
  reasonExpanded?: boolean;
  onReasonExpandedChange?: (expanded: boolean) => void;
  onMove?: (session: PlannedSession) => void;
  onSessionPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onSessionPointerMove?: (event: ReactPointerEvent<HTMLElement>) => void;
  onSessionPointerUp?: (event: ReactPointerEvent<HTMLElement>) => void;
  onSessionPointerCancel?: (event: ReactPointerEvent<HTMLElement>) => void;
  onSessionLostPointerCapture?: () => void;
}) {
  const {
    tasks,
    toggleSessionLock,
    rejectSession,
    requestAnotherTime,
    selectedSessionIds,
    toggleSelectedSession,
    approveSession,
  } = usePlanPilot();
  const actionable = session.status === "proposed" || session.status === "approved";
  const task = tasks.find((item) => item.id === session.taskId);
  const manuallyMovable =
    actionable &&
    task?.taskType !== "fixed_time" &&
    task?.recurrence?.mode !== "fixed_times";
  const canMove = manuallyMovable;
  const statusLabel = session.status.replace("_", " ");
  const isOverdue = session.reasonCodes.includes("OVERDUE_RECOVERY");
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = reasonExpanded ?? localExpanded;
  const toggleExpanded = () => {
    if (onReasonExpandedChange) onReasonExpandedChange(!expanded);
    else setLocalExpanded(!expanded);
  };
  const note = specificExplanation(session.explanation);
  const needsTimingCheck =
    !!task?.schedulingConstraints?.calculatedTiming && task.reviewRequired && session.status === "proposed";
  return (
    <article
      className={`schedule-session ${session.status === "approved" ? "session-approved" : ""} ${session.status === "proposed" ? "session-proposed" : ""} ${isOverdue ? "session-overdue" : ""} ${expanded ? "is-expanded" : ""}`}
      data-manually-draggable={canMove ? "true" : "false"}
      onPointerDown={canMove ? onSessionPointerDown : undefined}
      onPointerMove={canMove ? onSessionPointerMove : undefined}
      onPointerUp={canMove ? onSessionPointerUp : undefined}
      onPointerCancel={canMove ? onSessionPointerCancel : undefined}
      onLostPointerCapture={
        canMove ? onSessionLostPointerCapture : undefined
      }
      aria-label={`${session.title}, ${formatTime(session.start)} to ${formatTime(session.end)}, ${statusLabel}${session.locked ? ", locked" : ""}`}
    >
      <div className="session-row">
        {selectable && session.status === "proposed" && (
          <label className="session-select">
            <input
              type="checkbox"
              checked={selectedSessionIds.includes(session.id)}
              onChange={() => toggleSelectedSession(session.id)}
              aria-label={`Select ${session.title}`}
            />
          </label>
        )}
        <div className="session-main">
          <span className="session-when" title={`${formatTime(session.start)}–${formatTime(session.end)}`}>{compactTimeRange(session.start, session.end)}</span>
          {/* Non-breaking hyphens keep course codes like "220-2" on one line. */}
          <h3 title={session.title}>{session.title.replace(/(\w)-(\w)/g, "$1‑$2")}</h3>
        </div>
        {session.status === "proposed" ? (
          <button
            type="button"
            className="session-quick-approve"
            onClick={() => approveSession(session.id)}
            aria-label={`Approve ${session.title}`}
            title="Approve"
          >
            <Check size={14} aria-hidden="true" />
          </button>
        ) : (
          <span className={`session-status session-status-${session.status}`} title={statusLabel}>
            {session.status === "approved" || session.status === "completed" ? (
              <CheckCircle2 size={14} aria-hidden="true" />
            ) : (
              <small>{statusLabel}</small>
            )}
          </span>
        )}
        <button
          type="button"
          className="session-expand"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} details for ${session.title}`}
          onClick={toggleExpanded}
        >
          {expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
        </button>
      </div>
      {(isOverdue || needsTimingCheck) && (
        <div className="session-flags">
          {isOverdue && (
            <span className="session-overdue-badge" title="Scheduled after its deadline">
              <AlertTriangle size={11} aria-hidden="true" />
              Overdue
            </span>
          )}
          {needsTimingCheck && <Badge tone="warning">Calculated · check timing</Badge>}
        </div>
      )}
      {expanded && (
        <div className="session-details">
          <div className="reason-tags" aria-label="Why this time">
            <span className="reason-tags-label">Why</span>
            {session.reasonCodes.slice(0, 3).map((reason) => (
              <span key={reason}>{REASON_LABELS[reason as ScheduleReasonCode] ?? reason}</span>
            ))}
            <span className="reason-minutes">{session.minutes} min</span>
          </div>
          {note && <p className="session-note">{note}</p>}
          <div className="session-actions">
            {session.status === "proposed" && (
              <button type="button" onClick={() => approveSession(session.id)}><Check size={13} aria-hidden="true" /> Approve</button>
            )}
            {onMove && manuallyMovable && <button type="button" onClick={() => onMove(session)} disabled={!canMove}><MoveRight size={13} aria-hidden="true" /> Move</button>}
            {manuallyMovable && <button type="button" onClick={() => requestAnotherTime(session.id)} disabled={session.locked}><RotateCcw size={13} aria-hidden="true" /> Next opening</button>}
            {actionable && <button type="button" onClick={() => rejectSession(session.id)}><X size={13} aria-hidden="true" /> Reject</button>}
            <button
              type="button"
              className="session-lock"
              onClick={() => toggleSessionLock(session.id)}
              aria-pressed={session.locked}
              title={session.locked ? "Protected from automatic changes" : "Automatic changes allowed"}
            >
              {session.locked ? <Lock size={13} aria-hidden="true" /> : <LockOpen size={13} aria-hidden="true" />}
              {session.locked ? "Locked" : "Lock"}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

/** The seven days (Sunday through Saturday) of the week `offset` weeks from this one. */
function weekColumnsFor(offset: number) {
  const today = new Date(`${localDateKey()}T12:00:00Z`);
  const sunday = new Date(today);
  sunday.setUTCDate(today.getUTCDate() - today.getUTCDay() + offset * 7);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(sunday);
    date.setUTCDate(sunday.getUTCDate() + index);
    return {
      date: date.toISOString().slice(0, 10),
      label: new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(date),
      day: new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "UTC" }).format(date),
      range: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date),
      year: date.getUTCFullYear(),
    };
  });
}

function weekRangeLabel(columns: ReturnType<typeof weekColumnsFor>): string {
  const first = columns[0];
  const last = columns[columns.length - 1];
  const sameMonth = first.range.split(" ")[0] === last.range.split(" ")[0];
  return `${first.range} – ${sameMonth ? last.day : last.range}, ${last.year}`;
}

/** Height of one hour in the week's time grid, in pixels (1px per minute). */
const HOUR_PX = 60;

function minutesToClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function hourLabel(hour: number): string {
  if (hour === 0 || hour === 24) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

/** Start and end of a session in minutes after local midnight (end capped at midnight). */
function sessionClockRange(session: PlannedSession) {
  const start = clockMinutes(localTimeKey(session.start));
  return { start, end: Math.min(24 * 60, start + session.minutes) };
}

/** Places overlapping sessions side by side, like Google Calendar. Sessions must be sorted by start. */
function dayLanes(sessions: PlannedSession[]) {
  const result = new Map<string, { lane: number; lanes: number }>();
  let cluster: Array<{ id: string; lane: number; end: number }> = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((item) => item.lane + 1));
    for (const item of cluster) result.set(item.id, { lane: item.lane, lanes });
    cluster = [];
  };
  for (const session of sessions) {
    const { start, end } = sessionClockRange(session);
    if (start >= clusterEnd) {
      flush();
      clusterEnd = end;
    } else {
      clusterEnd = Math.max(clusterEnd, end);
    }
    const used = new Set(cluster.filter((item) => item.end > start).map((item) => item.lane));
    let lane = 0;
    while (used.has(lane)) lane += 1;
    cluster.push({ id: session.id, lane, end });
  }
  flush();
  return result;
}

function timeZoneShortName(): string {
  return (
    new Intl.DateTimeFormat("en-US", { timeZone: DEFAULT_PREFERENCES.timeZone, timeZoneName: "short" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}

type ManualPlacementDraft = {
  sessionId: string;
  date: string;
  time: string;
  editingDeadline: boolean;
  deadlineDate: string;
  deadlineTime: string;
};

function ScheduleView() {
  const {
    tasks,
    lastImportedTaskIds,
    proposal,
    approveAllSessions,
    selectedSessionIds,
    approveSession,
    exportApprovedSessions,
    exportState,
    placeSessionManually,
    planningRules,
    canUndoSchedule,
    undoScheduleLabel,
    undoSchedule,
  } = usePlanPilot();
  const [mode, setMode] = useState<"week" | "list">("week");
  const [scope, setScope] = useState<"recent" | "all">("all");
  const [weekOffset, setWeekOffset] = useState(0);
  const [expandedReasonIds, setExpandedReasonIds] = useState<string[]>([]);
  const [draggingSessionId, setDraggingSessionId] = useState<string>();
  const [dragTargetDate, setDragTargetDate] = useState<string>();
  const [dragTargetMinutes, setDragTargetMinutes] = useState<number>();
  const now = useClock();
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const [placementDraft, setPlacementDraft] =
    useState<ManualPlacementDraft>();
  const pointerDragRef = useRef<{
    sessionId: string;
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    active: boolean;
    targetDate?: string;
    targetMinutes?: number;
    grabOffsetY: number;
    length: number;
  } | undefined>(undefined);
  const latestTaskIds = new Set(lastImportedTaskIds);
  const visibleSessions = proposal.sessions.filter(
    (session) => scope === "all" || latestTaskIds.has(session.taskId),
  );
  const visibleUnschedulable = proposal.unschedulable.filter(
    (task) => scope === "all" || latestTaskIds.has(task.taskId),
  );
  const visibleCheckpoints = tasks.filter((task) =>
    task.responsibilityKind === "milestone" && task.dueAt && !task.completed && !task.cancelled
    && (scope === "all" || latestTaskIds.has(task.id ?? "")),
  );
  const arrivalBuffers = arrivalBufferReservations(tasks, true);
  const weekColumns = weekColumnsFor(weekOffset);
  const weekFirstDate = weekColumns[0].date;
  const weekLastDate = weekColumns[weekColumns.length - 1].date;
  const sessionsByDate = new Map<string, PlannedSession[]>();
  for (const session of [...visibleSessions].sort(
    (left, right) => new Date(left.start).getTime() - new Date(right.start).getTime(),
  )) {
    const key = localDateKey(new Date(session.start));
    if (key < weekFirstDate || key > weekLastDate) continue;
    sessionsByDate.set(key, [...(sessionsByDate.get(key) ?? []), session]);
  }
  const weekSessions = weekColumns.flatMap((day) => sessionsByDate.get(day.date) ?? []);
  // Hours shown in the grid: your usual day, stretched to fit any session outside it.
  const gridStart = Math.floor(
    Math.min(clockMinutes(DEFAULT_PREFERENCES.wakingTime), ...visibleSessions.map((session) => sessionClockRange(session).start)) / 60,
  ) * 60;
  const gridEnd = Math.min(
    24 * 60,
    Math.ceil(
      Math.max(clockMinutes(DEFAULT_PREFERENCES.sleepingTime), ...visibleSessions.map((session) => sessionClockRange(session).end)) / 60,
    ) * 60,
  );
  const gridHours = Array.from({ length: (gridEnd - gridStart) / 60 }, (_, index) => gridStart / 60 + index);
  const todayKey = localDateKey();
  const nowDateKey = now === undefined ? undefined : localDateKey(new Date(now));
  const nowMinute = now === undefined ? undefined : clockMinutes(localTimeKey(new Date(now)));
  const firstWeekMinute = weekSessions.length
    ? Math.min(...weekSessions.map((session) => sessionClockRange(session).start))
    : clockMinutes("09:00");
  const allReasonsExpanded =
    weekSessions.length > 0 &&
    weekSessions.every((session) => expandedReasonIds.includes(session.id));
  const toggleAllReasons = () => {
    setExpandedReasonIds(
      allReasonsExpanded ? [] : weekSessions.map((session) => session.id),
    );
  };
  const setReasonExpanded = (sessionId: string, expanded: boolean) => {
    setExpandedReasonIds((current) =>
      expanded
        ? current.includes(sessionId)
          ? current
          : [...current, sessionId]
        : current.filter((id) => id !== sessionId),
    );
  };
  const visibleSelectedIds = selectedSessionIds.filter((id) =>
    visibleSessions.some((session) => session.id === id),
  );
  const approveSelected = () => visibleSelectedIds.forEach(approveSession);
  const approveVisiblePlan = () => {
    if (scope === "all") {
      approveAllSessions();
      return;
    }
    visibleSessions
      .filter((session) => session.status === "proposed")
      .forEach((session) => approveSession(session.id));
  };

  const openPlacement = useCallback(
    (
      session: PlannedSession,
      date = localDateKey(new Date(session.start)),
      time = localTimeKey(session.start),
    ) => {
      const task = tasks.find((item) => item.id === session.taskId);
      if (
        !task ||
        task.taskType === "fixed_time" ||
        task.recurrence?.mode === "fixed_times"
      ) {
        return;
      }
      setPlacementDraft({
        sessionId: session.id,
        date,
        time,
        editingDeadline: false,
        deadlineDate: task.dueDate ?? date,
        deadlineTime: task.dueTime ?? "",
      });
    },
    [tasks],
  );
  const resetDrag = useCallback(() => {
    setDraggingSessionId(undefined);
    setDragTargetDate(undefined);
    setDragTargetMinutes(undefined);
  }, []);
  const beginPointerDrag = (
    session: PlannedSession,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (
      event.button !== 0 ||
      (event.target as Element).closest("button, input, a, select, textarea")
    ) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDragRef.current = {
      sessionId: session.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      active: false,
      grabOffsetY: event.clientY - event.currentTarget.getBoundingClientRect().top,
      length: session.minutes,
    };
  };
  const scheduleDateAtPoint = useCallback((clientX: number, clientY: number) => {
    const direct = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-schedule-date]")
      ?.dataset.scheduleDate;
    if (direct) return direct;
    return Array.from(
      document.querySelectorAll<HTMLElement>("[data-schedule-date]"),
    ).find((column) => {
      const bounds = column.getBoundingClientRect();
      return (
        clientX >= bounds.left &&
        clientX <= bounds.right &&
        clientY >= bounds.top &&
        clientY <= bounds.bottom
      );
    })?.dataset.scheduleDate;
  }, []);
  /** Start time (minutes after midnight, 15-minute steps) under the pointer in a day's time grid. */
  const gridMinutesAtPoint = useCallback(
    (date: string, clientY: number, grabOffsetY: number, length: number) => {
      const grid = document.querySelector<HTMLElement>(`[data-schedule-date="${date}"] .day-grid`);
      if (!grid) return undefined;
      const bounds = grid.getBoundingClientRect();
      const start = Number(grid.dataset.gridStart);
      const end = Number(grid.dataset.gridEnd);
      const raw = start + ((clientY - grabOffsetY - bounds.top) * 60) / HOUR_PX;
      return Math.max(start, Math.min(end - length, Math.round(raw / 15) * 15));
    },
    [],
  );
  const updateDragTarget = useCallback(
    (clientX: number, clientY: number) => {
      const current = pointerDragRef.current;
      if (!current) return;
      current.lastX = clientX;
      current.lastY = clientY;
      current.targetDate = scheduleDateAtPoint(clientX, clientY);
      current.targetMinutes = current.targetDate
        ? gridMinutesAtPoint(current.targetDate, clientY, current.grabOffsetY, current.length)
        : undefined;
    },
    [gridMinutesAtPoint, scheduleDateAtPoint],
  );
  const continuePointerDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = pointerDragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.lastX = event.clientX;
    current.lastY = event.clientY;
    if (
      !current.active &&
      Math.hypot(
        event.clientX - current.startX,
        event.clientY - current.startY,
      ) < 8
    ) {
      return;
    }
    if (!current.active) {
      current.active = true;
      setDraggingSessionId(current.sessionId);
    }
    event.preventDefault();
    updateDragTarget(event.clientX, event.clientY);
    setDragTargetDate(current.targetDate);
    setDragTargetMinutes(current.targetMinutes);
  };
  const completePointerDrag = useCallback(() => {
    const current = pointerDragRef.current;
    if (!current) return;
    const targetDate =
      current.targetDate ?? scheduleDateAtPoint(current.lastX, current.lastY);
    if (current.active && targetDate) {
      const session = proposal.sessions.find(
        (item) => item.id === current.sessionId,
      );
      if (session) {
        openPlacement(
          session,
          targetDate,
          current.targetMinutes !== undefined
            ? minutesToClock(current.targetMinutes)
            : localTimeKey(session.start),
        );
      }
    }
    pointerDragRef.current = undefined;
    resetDrag();
  }, [openPlacement, proposal.sessions, resetDrag, scheduleDateAtPoint]);
  const finishPointerDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const current = pointerDragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.active) updateDragTarget(event.clientX, event.clientY);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    completePointerDrag();
  };
  const cancelPointerDrag = (event: ReactPointerEvent<HTMLElement>) => {
    pointerDragRef.current = undefined;
    resetDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    if (!placementDraft) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPlacementDraft(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [placementDraft]);

  useEffect(() => {
    if (!draggingSessionId) return;
    const finishAtWindow = (event: PointerEvent) => {
      if (pointerDragRef.current?.pointerId === event.pointerId) {
        updateDragTarget(event.clientX, event.clientY);
        completePointerDrag();
      }
    };
    window.addEventListener("pointerup", finishAtWindow, true);
    return () => window.removeEventListener("pointerup", finishAtWindow, true);
  }, [draggingSessionId, completePointerDrag, updateDragTarget]);

  // Open each week scrolled to just before its first session (or the current time).
  const scrollTargetMinute =
    weekOffset === 0 && nowMinute !== undefined ? Math.min(firstWeekMinute, nowMinute) : firstWeekMinute;
  useEffect(() => {
    const grid = gridScrollRef.current;
    if (!grid || mode !== "week") return;
    grid.scrollTop = Math.max(0, ((scrollTargetMinute - 60 - gridStart) * HOUR_PX) / 60);
  }, [gridStart, mode, scrollTargetMinute, weekOffset, tasks.length]);

  const placementSession = placementDraft
    ? proposal.sessions.find(
        (session) => session.id === placementDraft.sessionId,
      )
    : undefined;
  const placementTask = placementSession
    ? tasks.find((task) => task.id === placementSession.taskId)
    : undefined;
  let placementStartAt: string | undefined;
  let placementEndAt: string | undefined;
  let placementError: string | undefined;
  if (placementDraft && placementSession) {
    try {
      placementStartAt = manualPlacementStart(
        placementDraft.date,
        placementDraft.time,
        DEFAULT_PREFERENCES.timeZone,
      );
      placementEndAt = manualPlacementEnd(
        placementStartAt,
        placementSession.minutes,
      );
    } catch (error) {
      placementError =
        error instanceof Error ? error.message : "Choose a valid date and time.";
    }
  }
  const currentDeadline = placementTask
    ? taskDeadlineInstant(
        placementTask,
        DEFAULT_PREFERENCES.timeZone,
        planningRules.latestWorkTime ?? DEFAULT_PREFERENCES.sleepingTime,
      )
    : undefined;
  const isPastDeadline =
    !!placementEndAt &&
    isManualPlacementAfterDeadline(
      placementTask,
      placementEndAt,
      DEFAULT_PREFERENCES.timeZone,
      planningRules.latestWorkTime ?? DEFAULT_PREFERENCES.sleepingTime,
    );
  const placementBreakMinutes = placementSession
    ? (proposal.breaks.find(
        (item) => item.afterSessionId === placementSession.id,
      )?.minutes ??
      (placementTask?.energyDemand === "high"
        ? DEFAULT_PREFERENCES.preferredBreakMinutes
        : 0))
    : 0;
  const placementImpactEndAt = placementEndAt
    ? placementBreakMinutes > 0
      ? manualPlacementEnd(placementEndAt, placementBreakMinutes)
      : placementEndAt
    : undefined;
  let deadlineEditError: string | undefined;
  if (
    placementDraft?.editingDeadline &&
    placementTask &&
    placementEndAt
  ) {
    try {
      const updatedTask = {
        ...placementTask,
        ...deadlineUpdateFields(
          {
            dueDate: placementDraft.deadlineDate,
            dueTime: placementDraft.deadlineTime || undefined,
          },
          DEFAULT_PREFERENCES.timeZone,
        ),
      };
      if (
        isManualPlacementAfterDeadline(
          updatedTask,
          placementEndAt,
          DEFAULT_PREFERENCES.timeZone,
          planningRules.latestWorkTime ?? DEFAULT_PREFERENCES.sleepingTime,
        )
      ) {
        deadlineEditError = "The new deadline must be at or after this session ends.";
      }
    } catch (error) {
      deadlineEditError =
        error instanceof Error ? error.message : "Choose a valid deadline.";
    }
  }
  const overlappingSessions =
    placementStartAt && placementImpactEndAt && placementSession
      ? proposal.sessions.filter(
          (session) =>
            session.id !== placementSession.id &&
            new Date(placementStartAt).getTime() <
              new Date(session.end).getTime() &&
            new Date(session.start).getTime() <
              new Date(placementImpactEndAt).getTime(),
        )
      : [];
  const placementSequenceGroup = placementTask
    ? taskSequence(placementTask)?.groupId
    : undefined;
  const relatedSessions = placementSession
    ? proposal.sessions.filter((session) => {
        if (session.id === placementSession.id) return false;
        const task = tasks.find(
          (item) => (item.id ?? item.title) === session.taskId,
        );
        return (
          session.taskId === placementSession.taskId ||
          (placementSequenceGroup !== undefined &&
            task &&
            taskSequence(task)?.groupId === placementSequenceGroup)
        );
      })
    : [];
  const flexibleSessionsToMove = [
    ...overlappingSessions,
    ...relatedSessions,
  ].filter(
    (session, index, all) =>
      session.status === "proposed" &&
      !session.locked &&
      all.findIndex((item) => item.id === session.id) === index,
  );
  const flexibleOverlapCount = flexibleSessionsToMove.length;
  const protectedOverlaps = overlappingSessions.filter(
    (session) => session.status !== "proposed" || session.locked,
  );
  const protectedRelated = relatedSessions.filter(
    (session) =>
      (session.status !== "proposed" || session.locked) &&
      !protectedOverlaps.some((item) => item.id === session.id),
  );
  const blockedOverlaps =
    placementStartAt && placementImpactEndAt
      ? (planningRules.blockedTimes ?? []).filter(
          (interval) =>
            new Date(placementStartAt).getTime() <
              new Date(interval.end).getTime() &&
            new Date(interval.start).getTime() <
              new Date(placementImpactEndAt).getTime(),
        )
      : [];
  const confirmPlacement = () => {
    if (
      !placementDraft ||
      !placementSession ||
      !placementStartAt ||
      placementError ||
      deadlineEditError
    ) {
      return;
    }
    placeSessionManually(
      placementSession.id,
      placementStartAt,
      placementDraft.editingDeadline
        ? {
            dueDate: placementDraft.deadlineDate,
            dueTime: placementDraft.deadlineTime || undefined,
          }
        : undefined,
    );
    setPlacementDraft(undefined);
  };
  if (tasks.length === 0) {
    return (
      <>
        <PageHeading
          eyebrow="PROPOSED SCHEDULE"
          title="No schedule has been generated."
          detail="A proposal appears after you import and review at least one responsibility."
        />
        <EmptyState
          illustration="route"
          title="Your week is open"
          detail="Add responsibilities to generate a deadline-aware schedule with workload risk and planning explanations."
          action={
            <Link href="/import" className="button button-primary button-md">
              <Plus size={16} /> Add responsibilities
            </Link>
          }
        />
      </>
    );
  }
  return (
    <>
      <PageHeading
        eyebrow="SCHEDULE"
        title="Your week"
        detail={
          scope === "recent"
            ? "Showing only what you just added."
            : "Drag a flexible session to another day to move it."
        }
        actions={
          <>
            <Button variant="secondary" onClick={approveSelected} disabled={!visibleSelectedIds.length}>
              Approve selected ({visibleSelectedIds.length})
            </Button>
            <Button onClick={approveVisiblePlan}><Check size={16} /> {scope === "recent" ? "Approve added sessions" : "Approve complete plan"}</Button>
          </>
        }
      />
      <PlanHealthPanel compact />
      {visibleCheckpoints.length > 0 && (
        <section className="panel" aria-label="Arrival and dependency checkpoints">
          <div className="panel-heading"><div><h2>Checkpoints</h2><p>Arrive-by and ready-by times.</p></div></div>
          <div className="unschedulable-list">
            {visibleCheckpoints.map((task) => (
              <div className="source-quote" key={task.id}>
                <span>{task.title} · {task.reviewRequired ? "Needs review" : "Confirmed checkpoint"}</span>
                <p>{formatDay(task.dueAt!, true)} at {formatTime(task.dueAt!)}</p>
                {arrivalBuffers.filter((buffer) => buffer.taskId === task.id).map((buffer) => (
                  <p key={buffer.taskId}>Reserved arrival buffer: {datedIntervalSummary(buffer.start, buffer.end)} · not active work{task.reviewRequired ? " · needs review" : ""}</p>
                ))}
                <Link href="/tasks/review">Review timing and source</Link>
              </div>
            ))}
          </div>
        </section>
      )}
      <div className="schedule-toolbar">
        <div className="week-nav" role="group" aria-label="Choose week">
          <button type="button" className="icon-button" onClick={() => setWeekOffset((value) => value - 1)} aria-label="Previous week" title="Previous week">
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" onClick={() => setWeekOffset((value) => value + 1)} aria-label="Next week" title="Next week">
            <ChevronRight size={18} aria-hidden="true" />
          </button>
          <h2 className="week-nav-range" aria-live="polite">{weekRangeLabel(weekColumns)}</h2>
          {weekOffset !== 0 && (
            <button type="button" className="week-nav-today" onClick={() => setWeekOffset(0)}>
              This week
            </button>
          )}
        </div>
        <div className="view-toggle" role="group" aria-label="Schedule layout">
          <button aria-pressed={mode === "week"} className={mode === "week" ? "active" : ""} onClick={() => setMode("week")}><CalendarDays size={15} aria-hidden="true" /> Timeline</button>
          <button aria-pressed={mode === "list"} className={mode === "list" ? "active" : ""} onClick={() => setMode("list")}><LayoutList size={15} aria-hidden="true" /> Task list</button>
        </div>
        {lastImportedTaskIds.length > 0 && (
          <div className="view-toggle schedule-scope-toggle" role="group" aria-label="Schedule responsibility scope">
            <button aria-pressed={scope === "recent"} className={scope === "recent" ? "active" : ""} onClick={() => setScope("recent")}>Just added</button>
            <button aria-pressed={scope === "all"} className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>All responsibilities</button>
          </div>
        )}
        <button
          type="button"
          className="reasoning-all-button"
          onClick={toggleAllReasons}
          aria-label={`${allReasonsExpanded ? "Hide" : "Show"} details for every session this week`}
        >
          {allReasonsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {allReasonsExpanded ? "Hide details" : "Show details"}
        </button>
        <Button
          variant="secondary"
          size="sm"
          className="schedule-undo-button"
          onClick={undoSchedule}
          disabled={!canUndoSchedule}
          title={
            canUndoSchedule
              ? `Undo ${undoScheduleLabel}`
              : "No schedule changes to undo"
          }
        >
          <Undo2 size={14} /> Undo
        </Button>
      </div>
      {mode === "week" ? (
        <div
          className={`time-grid ${draggingSessionId ? "is-dragging" : ""}`}
          ref={gridScrollRef}
          style={{ "--hour-px": `${HOUR_PX}px` } as React.CSSProperties}
        >
          <div className="time-grid-head">
            <div className="time-grid-corner">{timeZoneShortName()}</div>
            {weekColumns.map((day) => {
              const minutes = (sessionsByDate.get(day.date) ?? []).reduce((sum, session) => sum + session.minutes, 0);
              return (
                <div className={`time-grid-day ${day.date === todayKey ? "today" : ""}`} key={day.date}>
                  <span>{day.label}</span>
                  <strong>{day.day}</strong>
                  <small>{minutes > 0 ? `${minutes} min` : "Free"}</small>
                </div>
              );
            })}
          </div>
          <div className="time-grid-body">
            <div className="time-gutter" style={{ height: ((gridEnd - gridStart) * HOUR_PX) / 60 }} aria-hidden="true">
              {gridHours.map((hour) => (
                <span key={hour} style={{ top: (hour * 60 - gridStart) * (HOUR_PX / 60) }}>
                  {hour * 60 === gridStart ? "" : hourLabel(hour)}
                </span>
              ))}
            </div>
            {weekColumns.map((day) => {
              const sessions = sessionsByDate.get(day.date) ?? [];
              const lanes = dayLanes(sessions);
              const draggedSession = draggingSessionId
                ? proposal.sessions.find((item) => item.id === draggingSessionId)
                : undefined;
              return (
                <div
                  className={`time-grid-col ${day.date === todayKey ? "today" : ""} ${dragTargetDate === day.date ? "drag-target" : ""}`}
                  key={day.date}
                  data-schedule-date={day.date}
                >
                  <div
                    className="day-grid"
                    data-grid-start={gridStart}
                    data-grid-end={gridEnd}
                    style={{ height: ((gridEnd - gridStart) * HOUR_PX) / 60 }}
                  >
                    {sessions.map((session) => {
                      const { start, end } = sessionClockRange(session);
                      const lane = lanes.get(session.id) ?? { lane: 0, lanes: 1 };
                      const expanded = expandedReasonIds.includes(session.id);
                      return (
                        <div
                          key={session.id}
                          className={`grid-session ${expanded ? "is-expanded" : ""} ${end - start < 40 ? "is-short" : ""} ${draggingSessionId === session.id ? "is-dragged" : ""}`}
                          style={{
                            top: ((start - gridStart) * HOUR_PX) / 60,
                            height: Math.max(22, ((end - start) * HOUR_PX) / 60),
                            // How many lines of the name fit under the time before it is shortened.
                            "--title-lines": Math.max(1, Math.floor((Math.max(22, ((end - start) * HOUR_PX) / 60) - 20) / 14.4)),
                            left: `calc(${(lane.lane / lane.lanes) * 100}% + 2px)`,
                            width: `calc(${100 / lane.lanes}% - 5px)`,
                          } as React.CSSProperties}
                        >
                          <ScheduleSessionCard
                            session={session}
                            selectable={false}
                            onMove={openPlacement}
                            onSessionPointerDown={(event) =>
                              beginPointerDrag(session, event)
                            }
                            onSessionPointerMove={continuePointerDrag}
                            onSessionPointerUp={finishPointerDrag}
                            onSessionPointerCancel={cancelPointerDrag}
                            onSessionLostPointerCapture={completePointerDrag}
                            reasonExpanded={expanded}
                            onReasonExpandedChange={(open) =>
                              setReasonExpanded(session.id, open)
                            }
                          />
                        </div>
                      );
                    })}
                    {draggedSession && dragTargetDate === day.date && dragTargetMinutes !== undefined && (
                      <div
                        className="grid-drop-ghost"
                        aria-hidden="true"
                        style={{
                          top: ((dragTargetMinutes - gridStart) * HOUR_PX) / 60,
                          height: (draggedSession.minutes * HOUR_PX) / 60,
                        }}
                      >
                        {hourLabel(Math.floor(dragTargetMinutes / 60)).replace(" ", `:${String(dragTargetMinutes % 60).padStart(2, "0")} `)}
                      </div>
                    )}
                    {nowDateKey === day.date && nowMinute !== undefined && nowMinute >= gridStart && nowMinute <= gridEnd && (
                      <div className="grid-now-line" style={{ top: ((nowMinute - gridStart) * HOUR_PX) / 60 }} aria-hidden="true" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="schedule-list-view">
          {weekSessions.length === 0 && <p className="open-day">Nothing scheduled this week.</p>}
          {weekSessions.map((session, index) => (
            <div key={session.id}>
              {(index === 0 || localDateKey(new Date(weekSessions[index - 1].start)) !== localDateKey(new Date(session.start))) && (
                <span className="list-day">{formatDay(session.start, true)}</span>
              )}
              <ScheduleSessionCard
                session={session}
                onMove={openPlacement}
                reasonExpanded={expandedReasonIds.includes(session.id)}
                onReasonExpandedChange={(expanded) =>
                  setReasonExpanded(session.id, expanded)
                }
              />
            </div>
          ))}
        </div>
      )}
      {placementDraft && placementSession && placementTask && (
        <div
          className="placement-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) {
              setPlacementDraft(undefined);
            }
          }}
        >
          <section
            className="placement-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="placement-dialog-title"
          >
            <form
              onSubmit={(event) => {
                event.preventDefault();
                confirmPlacement();
              }}
            >
              <header>
                <span><MoveRight size={19} /></span>
                <div>
                  <p>VERIFY MANUAL PLACEMENT</p>
                  <h2 id="placement-dialog-title">Place “{placementSession.title}” here?</h2>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Cancel manual placement"
                  onClick={() => setPlacementDraft(undefined)}
                >
                  <X size={16} />
                </button>
              </header>

              <div className="placement-dialog-body">
                <p className="placement-intro">
                  Your confirmed time becomes protected. Automatic scheduling will
                  move flexible work around it instead of overriding your choice.
                </p>
                <div className="placement-fields">
                  <label>
                    Date
                    <input
                      type="date"
                      autoFocus
                      value={placementDraft.date}
                      min={localDateKey()}
                      onChange={(event) =>
                        setPlacementDraft((current) =>
                          current
                            ? { ...current, date: event.target.value }
                            : current,
                        )
                      }
                    />
                  </label>
                  <label>
                    Start time
                    <input
                      type="time"
                      step={900}
                      value={placementDraft.time}
                      onChange={(event) =>
                        setPlacementDraft((current) =>
                          current
                            ? { ...current, time: event.target.value }
                            : current,
                        )
                      }
                    />
                  </label>
                  <div className="placement-duration">
                    <span>Result</span>
                    <strong>
                      {placementStartAt && placementEndAt
                        ? `${formatDay(placementStartAt, true)} · ${formatTime(placementStartAt)}–${formatTime(placementEndAt)}`
                        : "Choose a valid date and time"}
                    </strong>
                    <small>{placementSession.minutes} minutes · {timeZoneName()}</small>
                  </div>
                </div>
                {placementError && (
                  <p className="placement-field-error" role="alert">
                    {placementError}
                  </p>
                )}

                {isPastDeadline && (
                  <section className="placement-deadline-warning">
                    <span><AlertTriangle size={18} /></span>
                    <div>
                      <strong>This session ends after the current deadline.</strong>
                      <p>
                        {currentDeadline
                          ? `Current deadline: ${
                              placementTask.dueDate && !placementTask.dueTime
                                ? `${shortDate(placementTask.dueDate)} at the end of your planning day`
                                : `${formatDay(currentDeadline, true)} at ${formatTime(currentDeadline)}`
                            }. Is there a new deadline?`
                          : "Is there a new deadline?"}
                      </p>
                      {!placementDraft.editingDeadline && (
                        <button
                          type="button"
                          onClick={() =>
                            setPlacementDraft((current) =>
                              current
                                ? { ...current, editingDeadline: true }
                                : current,
                            )
                          }
                        >
                          <PencilLine size={14} /> Change deadline
                        </button>
                      )}
                    </div>
                  </section>
                )}

                {placementDraft.editingDeadline && (
                  <fieldset className="placement-deadline-editor">
                    <legend>New deadline</legend>
                    <p>Leave the time blank to use the end of your planning day.</p>
                    <div>
                      <label>
                        Deadline date
                        <input
                          type="date"
                          value={placementDraft.deadlineDate}
                          onChange={(event) =>
                            setPlacementDraft((current) =>
                              current
                                ? { ...current, deadlineDate: event.target.value }
                                : current,
                            )
                          }
                        />
                      </label>
                      <label>
                        Deadline time <span>Optional</span>
                        <input
                          type="time"
                          value={placementDraft.deadlineTime}
                          onChange={(event) =>
                            setPlacementDraft((current) =>
                              current
                                ? { ...current, deadlineTime: event.target.value }
                                : current,
                            )
                          }
                        />
                      </label>
                    </div>
                    {deadlineEditError && (
                      <p className="placement-field-error" role="alert">
                        {deadlineEditError}
                      </p>
                    )}
                  </fieldset>
                )}

                {(flexibleOverlapCount > 0 ||
                  protectedOverlaps.length > 0 ||
                  protectedRelated.length > 0 ||
                  blockedOverlaps.length > 0) && (
                  <section className="placement-conflicts">
                    <Info size={17} />
                    <div>
                      <strong>Your choice stays in place.</strong>
                      {flexibleOverlapCount > 0 && (
                        <p>
                          {flexibleOverlapCount} flexible {flexibleOverlapCount === 1 ? "session" : "sessions"} in this time, its recovery break, or the same sequence will be moved automatically.
                        </p>
                      )}
                      {protectedOverlaps.length > 0 && (
                        <p>
                          It or its recovery break overlaps protected work: {protectedOverlaps.map((session) => session.title).join(", ")}. That conflict will remain visible.
                        </p>
                      )}
                      {protectedRelated.length > 0 && (
                        <p>
                          Protected related work stays in place, so any ordering conflict will remain visible.
                        </p>
                      )}
                      {blockedOverlaps.length > 0 && (
                        <p>
                          It also overlaps {blockedOverlaps.length} protected {blockedOverlaps.length === 1 ? "time block" : "time blocks"}.
                        </p>
                      )}
                    </div>
                  </section>
                )}
              </div>

              <footer>
                <button
                  type="button"
                  className="button button-secondary button-md"
                  onClick={() => setPlacementDraft(undefined)}
                >
                  Cancel
                </button>
                {placementDraft.editingDeadline && (
                  <button
                    type="button"
                    className="button button-secondary button-md"
                    onClick={() =>
                      setPlacementDraft((current) =>
                        current
                          ? { ...current, editingDeadline: false }
                          : current,
                      )
                    }
                  >
                    Keep current deadline
                  </button>
                )}
                <button
                  type="submit"
                  className="button button-primary button-md"
                  disabled={
                    !placementStartAt ||
                    !!placementError ||
                    !!deadlineEditError
                  }
                >
                  <Check size={15} />
                  {placementDraft.editingDeadline
                    ? "Update deadline & place"
                    : isPastDeadline
                      ? "Keep deadline & place"
                      : "Confirm & lock time"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
      <div className={`schedule-bottom-grid ${visibleUnschedulable.length === 0 ? "is-single" : ""}`}>
        {visibleUnschedulable.length > 0 && (
          <section className="panel">
            <div className="panel-heading"><div><h2>Doesn’t fit yet</h2></div></div>
            <div className="unschedulable-list">
              {visibleUnschedulable.map((task) => <UnschedulableTaskCard task={task} responsibility={tasks.find((item) => item.id === task.taskId)} key={task.taskId} />)}
            </div>
          </section>
        )}
        <section className="export-panel">
          <span><CalendarDays size={21} /></span>
          <div>
            <h2>Export to Google Calendar</h2>
            <p>{proposal.sessions.filter((session) => session.status === "approved").length} approved sessions, all weeks. One-time download, no live sync.</p>
            <Button onClick={exportApprovedSessions} disabled={exportState === "loading" || !proposal.sessions.some((session) => session.status === "approved")}>
              {exportState === "loading" ? <RefreshCw className="spin" size={16} /> : <Download size={16} />}
              {exportState === "loading" ? "Preparing…" : "Download calendar file"}
            </Button>
            <p>Then in Google Calendar: Settings → Import &amp; export. <a href="https://support.google.com/calendar/answer/37118" target="_blank" rel="noreferrer">Help</a></p>
          </div>
        </section>
      </div>
    </>
  );
}

export function ChangeDiff() {
  const { replan, applyReplan } = usePlanPilot();
  if (!replan) return null;
  const change = replan.changes[0];
  if (!change) return null;
  return (
    <section className="change-diff">
      <div className="diff-heading">
        <div><Badge tone="info">Proposed change</Badge><h2>One session moves. Everything else stays.</h2><p>{replan.explanation}</p></div>
        <Badge tone="success">{replan.preservedSessionIds.length} sessions preserved</Badge>
      </div>
      <div className="diff-grid">
        <article className="diff-before">
          <span>Before</span>
          {"before" in change ? (
            <>
              <strong>{change.before.title}</strong>
              <p>{formatDay(change.before.start, true)}</p>
              <b>{formatTime(change.before.start)}–{formatTime(change.before.end)}</b>
              <Badge tone="danger">Missed</Badge>
            </>
          ) : null}
        </article>
        <MoveRight size={22} />
        <article className="diff-after">
          <span>After</span>
          {"after" in change ? (
            <>
              <strong>{change.after.title}</strong>
              <p>{formatDay(change.after.start, true)}</p>
              <b>{formatTime(change.after.start)}–{formatTime(change.after.end)}</b>
              <Badge tone="success">Valid opening</Badge>
            </>
          ) : <p>Unable to place remaining work.</p>}
        </article>
      </div>
      <div className="diff-footer">
        <p><ShieldCheck size={16} /> Locked, completed, and valid future sessions remain unchanged.</p>
        <Button onClick={applyReplan}><Check size={15} /> Apply this change</Button>
      </div>
    </section>
  );
}

function DailyReviewView() {
  const {
    proposal,
    replan,
    reviewQueue,
    sessionReviews,
    reviewSession,
    delaySessionReview,
  } = usePlanPilot();
  const [outcome, setOutcome] = useState<"completed" | "partial" | "missed" | "unnecessary" | null>(null);
  const [minutes, setMinutes] = useState(20);
  const [activeSessionId, setActiveSessionId] = useState<string>();
  const nextCheckIn = reviewQueue[0];
  const next = nextCheckIn?.session;
  const nextUp = reviewQueue[1]?.session ?? proposal.sessions.find(
    (session) =>
      (!next || new Date(session.start).getTime() > new Date(next.end).getTime()) &&
      (session.status === "approved" || session.status === "proposed"),
  );
  const selectedOutcome = activeSessionId === next?.id ? outcome : null;
  const selectedMinutes = activeSessionId === next?.id
    ? minutes
    : next
      ? Math.max(1, Math.min(20, next.minutes - 1))
      : 1;
  const reviewedToday = sessionReviews.filter(
    (review) => localDateKey(new Date(review.reviewedAt)) === localDateKey(),
  ).length;
  const reviewTotal = reviewedToday + reviewQueue.length;
  const activeCount = reviewQueue.filter((item) => item.phase === "in_progress").length;
  const needsReviewCount = reviewQueue.length - activeCount;

  const submit = () => {
    if (!next || !selectedOutcome) return;
    reviewSession(next.id, selectedOutcome, selectedOutcome === "partial" ? selectedMinutes : undefined);
    setOutcome(null);
  };

  if (!next) {
    return (
      <>
        <PageHeading
          eyebrow="DAILY REVIEW"
          title={replan ? "Your outcome is saved." : "Nothing needs an outcome."}
          detail={replan
            ? "Choose whether to add the calculated recovery session. Your recorded outcome will remain either way."
            : "Approved sessions appear here as soon as their scheduled start time arrives."}
        />
        {replan ? <ChangeDiff /> : (
          <EmptyState
            illustration="clear"
            title="Daily review is clear"
            detail="Future and unapproved sessions stay out of this queue. An approved session becomes actionable at its start time and remains here until you record an outcome."
            action={
              proposal.sessions.length === 0 ? (
                <Link href="/import" className="button button-primary button-md">
                  <Plus size={16} /> Add responsibilities
                </Link>
              ) : (
                <Link href="/schedule" className="button button-primary button-md">
                  <CalendarDays size={16} /> View schedule
                </Link>
              )
            }
          />
        )}
      </>
    );
  }

  const startDate = new Date(next.start);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_PREFERENCES.timeZone,
    weekday: "short",
  }).format(startDate).toUpperCase();
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_PREFERENCES.timeZone,
    day: "numeric",
  }).format(startDate);
  const progress = reviewTotal > 0 ? (reviewedToday / reviewTotal) * 100 : 0;
  const invalidPartial =
    selectedOutcome === "partial" && (selectedMinutes <= 0 || selectedMinutes >= next.minutes);

  return (
    <>
      <PageHeading
        eyebrow="DAILY REVIEW"
        title={nextCheckIn.phase === "in_progress" ? "Working on this now?" : "What actually happened?"}
        detail={nextCheckIn.phase === "in_progress"
          ? "Finish early whenever the planned work is done, or record partial progress. Missed becomes available after the session ends."
          : "Record the real outcome. Remaining work is recalculated from this exact session before any recovery block is added."}
      />
      <div className="review-progress">
        <div><span style={{ width: `${progress}%` }} /></div>
        <p>{reviewedToday} reviewed today · {activeCount} active · {needsReviewCount} need review</p>
      </div>
      <div className="daily-layout">
        <section className="daily-card">
          <div className="daily-card-head">
            <div className="date-tile large"><span>{weekday}</span><strong>{day}</strong></div>
            <div>
              <Badge tone={nextCheckIn.phase === "in_progress" ? "info" : "warning"}>
                {nextCheckIn.phase === "in_progress" ? "In progress now" : next.status === "in_progress" ? "Check-in due" : "Needs review"}
              </Badge>
              <h2>{next.title}</h2>
              <p>{formatTime(next.start)}–{formatTime(next.end)} · {next.minutes} planned minutes</p>
            </div>
          </div>
          <p className="daily-question">{nextCheckIn.phase === "in_progress" ? "How is this session going?" : "How did this session go?"}</p>
          <div className="outcome-grid" role="group" aria-label="Session outcome">
            <button aria-pressed={selectedOutcome === "completed"} className={selectedOutcome === "completed" ? "selected success" : ""} onClick={() => { setActiveSessionId(next.id); setOutcome("completed"); }}><CheckCircle2 size={20} aria-hidden="true" /><strong>{nextCheckIn.phase === "in_progress" ? "Finish early" : "Completed"}</strong><span>All planned work done</span></button>
            <button aria-pressed={selectedOutcome === "partial"} className={selectedOutcome === "partial" ? "selected" : ""} onClick={() => { setActiveSessionId(next.id); setOutcome("partial"); setMinutes(selectedMinutes); }}><PanelLeft size={20} aria-hidden="true" /><strong>Partially completed</strong><span>Some effort remains</span></button>
            <button aria-pressed={selectedOutcome === "missed"} disabled={nextCheckIn.phase === "in_progress"} className={selectedOutcome === "missed" ? "selected warning" : ""} onClick={() => { setActiveSessionId(next.id); setOutcome("missed"); }}><RotateCcw size={20} aria-hidden="true" /><strong>Missed</strong><span>{nextCheckIn.phase === "in_progress" ? "Available after session end" : "Move the work forward"}</span></button>
            <button aria-pressed={selectedOutcome === "unnecessary"} className={selectedOutcome === "unnecessary" ? "selected" : ""} onClick={() => { setActiveSessionId(next.id); setOutcome("unnecessary"); }}><X size={20} aria-hidden="true" /><strong>No longer needed</strong><span>Remove remaining work</span></button>
          </div>
          {selectedOutcome === "partial" && (
            <div className="partial-input">
              <label>Minutes completed<input type="number" min={1} max={next.minutes - 1} value={selectedMinutes} onChange={(event) => { setActiveSessionId(next.id); setMinutes(Number(event.target.value)); }} /></label>
              <span><strong>{Math.max(0, next.minutes - selectedMinutes)} min</strong> will remain</span>
            </div>
          )}
          <div className="daily-actions">
            <Button variant="secondary" onClick={() => delaySessionReview(next.id)}>
              Still working · ask in 15 min
            </Button>
            <Button onClick={submit} disabled={!selectedOutcome || invalidPartial}>
              Save outcome <ArrowRight size={15} />
            </Button>
          </div>
        </section>
        <aside>
          <section className="panel">
            <span className="eyebrow">NEXT UP</span>
            {nextUp ? (
              <>
                <h3>{nextUp.title}</h3>
                <p>{formatDay(nextUp.start, true)} · {formatTime(nextUp.start)}</p>
                <Badge>{nextUp.minutes} minutes</Badge>
              </>
            ) : <p>No upcoming sessions.</p>}
          </section>
          <section className="calm-note"><ShieldCheck size={18} /><p><strong>Minimal disruption is the rule.</strong> Valid future sessions stay in place, even when unlocked.</p></section>
        </aside>
      </div>
      {replan && <ChangeDiff />}
    </>
  );
}

function ChangesView() {
  const { history } = usePlanPilot();
  const iconFor = (icon: string) =>
    icon === "move" ? MoveRight : icon === "calendar" ? CalendarDays : icon === "complete" ? CheckCircle2 : PencilLine;
  if (history.length === 0) {
    return (
      <>
        <PageHeading
          eyebrow="CHANGE HISTORY"
          title="No meaningful changes yet."
          detail="Task edits, approvals, schedule moves, outcomes, and calendar exports will appear here."
        />
        <EmptyState
          illustration="history"
          title="History is empty"
          detail="Use the app normally and PlanPilot will record only changes that affect your plan."
        />
      </>
    );
  }
  return (
    <>
      <PageHeading
        eyebrow="CHANGE HISTORY"
        title="A clear record of meaningful changes."
        detail="Deadline edits, approvals, schedule moves, outcomes, and calendar exports are append-only."
      />
      <div className="changes-layout">
        <section className="panel history-panel">
          <div className="history-filter">
            <button className="active">All activity</button><button>Tasks</button><button>Schedule</button><button>Calendar</button>
          </div>
          <div className="history-timeline">
            {history.map((item, index) => {
              const Icon = iconFor(item.icon);
              return (
                <article key={item.id}>
                  <div className="history-axis"><span><Icon size={16} /></span>{index < history.length - 1 && <i />}</div>
                  <div><small>{item.at}</small><h3>{item.title}</h3><p>{item.detail}</p>{item.icon === "move" && <button>View before and after <ChevronRight size={13} /></button>}</div>
                </article>
              );
            })}
          </div>
        </section>
        <aside className="panel history-info">
          <span><History size={20} /></span>
          <h2>Why history matters</h2>
          <p>You can trace how imported words became tasks, why a session moved, and when an external event was created.</p>
          <div><strong>Not recorded</strong><span>Opening a card, changing a filter, or other inconsequential UI actions.</span></div>
          <div><strong>Always recorded</strong><span>Deadline changes, approvals, moves, outcomes, and exports.</span></div>
        </aside>
      </div>
    </>
  );
}

function SettingsView() {
  const {
    planningMode,
    setPlanningMode,
    theme,
    toggleTheme,
    importText,
    setImportText,
  } = usePlanPilot();
  const [message, setMessage] = useState<string>();
  const confirmAction = (question: string, action: () => void, result: string) => {
    if (window.confirm(question)) {
      action();
      setMessage(result);
    }
  };
  return (
    <>
      <PageHeading eyebrow="SETTINGS" title="Planning rules and privacy." detail="Control buffer, reminders, integrations, source retention, and account data." />
      {message && <div className="settings-message" role="status"><CheckCircle2 size={17} />{message}<button onClick={() => setMessage(undefined)}><X size={14} /></button></div>}
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <a href="#planning" className="active">Planning preferences</a>
          <a href="#calendar">Calendar</a>
          <a href="#appearance">Appearance</a>
          <a href="#privacy">Privacy & data</a>
        </nav>
        <div className="settings-panels">
          <section className="panel settings-section" id="planning">
            <div className="settings-heading"><span><BarChart3 size={19} /></span><div><h2>Planning mode</h2><p>Exact, testable density rules for every proposal.</p></div></div>
            <div className="settings-modes">
              {([
                ["conservative", "25% buffer", "Up to 2 demanding blocks daily"],
                ["balanced", "15% buffer", "Up to 3 demanding blocks daily"],
                ["aggressive", "5% buffer", "Denser, never past hard constraints"],
              ] as const).map(([value, label, detail]) => (
                <button key={value} className={planningMode === value ? "active" : ""} onClick={() => setPlanningMode(value)}>
                  <span>{planningMode === value && <Check size={13} />}</span>
                  <div><strong>{value[0].toUpperCase() + value.slice(1)}</strong><p>{label} · {detail}</p></div>
                </button>
              ))}
            </div>
            <div className="settings-fields">
              <label>Preferred focus block<select defaultValue="45"><option value="30">30 minutes</option><option value="45">45 minutes</option><option value="60">60 minutes</option></select></label>
              <label>Maximum focus block<select defaultValue="90"><option value="60">60 minutes</option><option value="90">90 minutes</option><option value="120">120 minutes</option></select></label>
              <label>Break after demanding work<select defaultValue="10"><option value="5">5 minutes</option><option value="10">10 minutes</option><option value="15">15 minutes</option></select></label>
              <label>Calendar reminder<select defaultValue="10"><option value="0">None</option><option value="10">10 minutes before</option><option value="15">15 minutes before</option></select></label>
            </div>
          </section>
          <section className="panel settings-section" id="calendar">
            <div className="settings-heading"><span><CalendarDays size={19} /></span><div><h2>Google Calendar</h2><p>Export approved sessions as a calendar file you can import.</p></div></div>
            <div className="connection-row">
              <div className="google-mark">G</div>
              <div><strong>Google Calendar</strong><p>Calendar file export · No connection needed</p></div>
              <Badge tone="success">Available</Badge>
              <Link href="/schedule" className="button button-secondary button-sm">Open schedule</Link>
            </div>
            <p className="settings-footnote">Approve your sessions on Schedule, then choose Export to Google Calendar. On a computer, import the downloaded .ics file in Google Calendar → Settings → Import &amp; export. Automatic sync and reading Google busy time are not connected.</p>
          </section>
          <section className="panel settings-section" id="appearance">
            <div className="settings-heading"><span>{theme === "light" ? <Sun size={19} /> : <Moon size={19} />}</span><div><h2>Appearance</h2><p>High-contrast light and dark themes.</p></div></div>
            <label className="switch-row"><span><strong>Dark mode</strong><small>Use the darker PlanPilot palette.</small></span><input type="checkbox" checked={theme === "dark"} onChange={toggleTheme} /></label>
          </section>
          <section className="panel settings-section danger-section" id="privacy">
            <div className="settings-heading"><span><ShieldCheck size={19} /></span><div><h2>Privacy & data</h2><p>Source text is separate from normalized tasks so it can be deleted independently.</p></div></div>
            <div className="data-action"><div><strong>Delete imported source text</strong><p>{importText ? "Current demo source is retained." : "No demo source text retained."}</p></div><Button variant="secondary" size="sm" onClick={() => confirmAction("Delete the imported source text? Normalized demo tasks will remain.", () => setImportText(""), "Imported source text deleted from this demo session.")}>Delete source</Button></div>
            <div className="data-action"><div><strong>Delete task history</strong><p>Removes meaningful change records. This cannot be undone.</p></div><Button variant="secondary" size="sm" onClick={() => confirmAction("Permanently delete task history?", () => undefined, "Demo history was left unchanged because it is seeded sample data.")}>Delete history</Button></div>
            <div className="data-action"><div><strong>Delete account and associated data</strong><p>Production uses cascading deletion after a fresh confirmation.</p></div><Button variant="danger" size="sm" onClick={() => confirmAction("Delete this account and all associated data? This action cannot be undone.", () => undefined, "Account deletion is disabled in demo mode.")}>Delete account</Button></div>
            <p className="privacy-copy">PlanPilot sends imported text to the configured AI provider (Gemini or OpenAI) only when that provider is enabled; local mode keeps interpretation inside this app. No claim is made here about model training or retention beyond the configured provider’s policy.</p>
          </section>
        </div>
      </div>
    </>
  );
}

export default function PlanPilotApp({ view }: { view: PlanPilotView }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("v") === packageJson.version) return;
    url.searchParams.set("v", packageJson.version);
    window.history.replaceState(window.history.state, "", url);
  }, []);

  if (view === "landing") return <LandingExperience />;
  if (view === "login") return <LoginView />;
  if (view === "onboarding") return <OnboardingView />;
  const content =
    view === "dashboard" ? <DashboardView /> :
    view === "import" ? <ImportView /> :
    view === "review" ? <ReviewView /> :
    view === "schedule" ? <ScheduleView /> :
    view === "daily-review" ? <DailyReviewView /> :
    view === "changes" ? <ChangesView /> :
    <SettingsView />;
  return <AppShell view={view}>{content}</AppShell>;
}
