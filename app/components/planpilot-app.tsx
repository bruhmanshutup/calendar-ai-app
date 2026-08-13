"use client";

import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  Clock3,
  Cloud,
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
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import type {
  DayOfWeek,
  ExtractedTask,
  PlannedSession,
  PlanningMode,
  ScheduleReasonCode,
  UnschedulableTask,
} from "@/lib/domain/types";
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
import { usePlanPilot } from "./planpilot-provider";

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
  { href: "/changes", label: "Changes", icon: History, view: "changes" },
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
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDay(value: string, long = false): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: long ? "long" : "short",
    month: long ? "long" : "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatToday(long = false): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: long ? "long" : "short",
    month: long ? "long" : "short",
    day: "numeric",
  }).format(new Date());
}

function localDateKey(value = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
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

function taskTimingSummary(task: ExtractedTask): string | undefined {
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
  if (constraints.avoidConsecutiveDays) parts.push("Rest days when possible");
  if (constraints.sessionCount) parts.push(`${constraints.sessionCount} sessions`);
  return parts.join(" · ") || undefined;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link className="brand" href="/">
      <span className="brand-mark" aria-hidden="true">
        <Waypoints size={compact ? 18 : 20} strokeWidth={2.3} />
      </span>
      <span className="brand-name">PlanPilot</span>
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
          <h2>{health.scheduledPercent}% of estimated work fits</h2>
          <p>{health.summary}</p>
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
          <strong>{Math.round(health.bufferMinutesRetained / 60)}h {health.bufferMinutesRetained % 60}m</strong>
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
  title,
  detail,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span><Icon size={22} /></span>
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
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      <CheckCircle2 size={18} />
      <span>{toast}</span>
      <button onClick={clearToast} aria-label="Dismiss message">
        <X size={16} />
      </button>
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
              >
                <Icon size={18} />
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
          <Link
            href="/settings"
            className={view === "settings" ? "active" : ""}
          >
            <Settings size={18} />
            <span>Settings</span>
          </Link>
          <button onClick={toggleTheme} className="sidebar-action">
            {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
            <span>{theme === "light" ? "Dark mode" : "Light mode"}</span>
          </button>
          <button className="sidebar-action">
            <CircleHelp size={18} />
            <span>Help & feedback</span>
          </button>
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
          <div className="topbar-context">
            <span className="sync-dot" />
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
              <Trash2 size={16} />
              <span>Clear all</span>
            </button>
            <Link href="/import" className="topbar-add">
              <Plus size={17} />
              Add
            </Link>
          </div>
        </header>
        <div className="app-content">{children}</div>
      </main>
      <Toast />
    </div>
  );
}

function LandingView() {
  return (
    <div className="landing">
      <header className="landing-nav">
        <Brand />
        <nav aria-label="Landing navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#trust">Why PlanPilot</a>
        </nav>
        <div>
          <Link href="/login" className="text-link">Sign in</Link>
          <Link href="/onboarding" className="button button-primary button-md">
            Try the demo
            <ArrowRight size={16} />
          </Link>
        </div>
      </header>
      <main>
        <section className="hero">
          <div className="hero-copy">
            <Badge tone="info">
              <Sparkles size={13} />
              Planning that explains itself
            </Badge>
            <h1>
              Turn messy responsibilities into a plan you can <em>trust.</em>
            </h1>
            <p>
              Paste an assignment sheet, checklist, or chaotic block of text.
              PlanPilot finds the work, flags uncertainty, and builds a realistic
              schedule around your actual time.
            </p>
            <div className="hero-actions">
              <Link href="/onboarding" className="button button-primary button-lg">
                Build my plan
                <ArrowRight size={17} />
              </Link>
              <Link href="/dashboard" className="button button-secondary button-lg">
                Explore the demo
              </Link>
            </div>
            <div className="trust-row">
              <span><Check size={14} /> No invented deadlines</span>
              <span><Check size={14} /> Nothing exported before approval</span>
              <span><Check size={14} /> Replans preserve your week</span>
            </div>
          </div>
          <div className="hero-product" aria-label="PlanPilot product preview">
            <div className="preview-window">
              <div className="preview-chrome">
                <div><i /><i /><i /></div>
                <span>Thursday · Your proposed plan</span>
                <Badge tone="success">Realistic</Badge>
              </div>
              <div className="preview-body">
                <div className="preview-health">
                  <div className="mini-ring"><strong>86%</strong></div>
                  <div>
                    <span>PLAN HEALTH</span>
                    <h3>Most work fits comfortably.</h3>
                    <p>Chemistry review has only 20 minutes of buffer.</p>
                  </div>
                </div>
                <div className="preview-grid">
                  <div className="preview-timeline">
                    <span className="preview-now">4 PM</span>
                    <article className="preview-session session-blue">
                      <small>4:15–5:00 PM</small>
                      <strong>Chemistry review</strong>
                      <p><Sparkles size={12} /> Preferred focus window</p>
                    </article>
                    <span className="preview-now">5 PM</span>
                    <article className="preview-session session-green">
                      <small>5:30–6:15 PM</small>
                      <strong>Gym session</strong>
                      <p><Target size={12} /> Spaced from Tuesday</p>
                    </article>
                    <span className="preview-now">6 PM</span>
                  </div>
                  <div className="preview-risk">
                    <span><AlertTriangle size={15} /> Needs attention</span>
                    <strong>30 min won’t fit</strong>
                    <p>Keep Saturday morning open or shorten the essay estimate.</p>
                    <button>See options <ChevronRight size={14} /></button>
                  </div>
                </div>
              </div>
            </div>
            <div className="floating-note floating-note-one">
              <span><ShieldCheck size={16} /></span>
              <div><strong>Uncertainty preserved</strong><small>“Soon” stays unscheduled</small></div>
            </div>
            <div className="floating-note floating-note-two">
              <span><RefreshCw size={16} /></span>
              <div><strong>One change, not a reset</strong><small>Missed work moved to Wed</small></div>
            </div>
          </div>
        </section>
        <section className="principles" id="how-it-works">
          <div className="section-intro">
            <span className="eyebrow">FROM SOURCE TO SCHEDULE</span>
            <h2>A calmer way to answer “what do I do next?”</h2>
            <p>AI interprets the language. Transparent rules build the calendar.</p>
          </div>
          <div className="principle-grid">
            <article>
              <span>01</span>
              <div className="principle-icon"><FileText size={22} /></div>
              <h3>Bring the mess</h3>
              <p>Paste text or upload a TXT file. Tasks and context are separated without hiding the source.</p>
            </article>
            <article>
              <span>02</span>
              <div className="principle-icon"><ShieldCheck size={22} /></div>
              <h3>Review what’s uncertain</h3>
              <p>Low-confidence dates, times, and effort estimates are highlighted field by field.</p>
            </article>
            <article>
              <span>03</span>
              <div className="principle-icon"><Waypoints size={22} /></div>
              <h3>Approve a realistic plan</h3>
              <p>Every block has a reason, buffer is protected, and overload is shown plainly.</p>
            </article>
          </div>
        </section>
        <section className="trust-section" id="trust">
          <div>
            <span className="eyebrow">CONTROL STAYS WITH YOU</span>
            <h2>A planning layer, not another calendar clone.</h2>
          </div>
          <div className="trust-points">
            <p><CheckCircle2 /> Fixed events and deadlines are never confused.</p>
            <p><CheckCircle2 /> Missed sessions trigger a minimal change proposal.</p>
            <p><CheckCircle2 /> Calendar writes happen only after explicit approval.</p>
          </div>
        </section>
      </main>
      <footer className="landing-footer">
        <Brand compact />
        <p>Plan with reality, not wishful thinking.</p>
        <span>© 2026 PlanPilot</span>
      </footer>
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
                <select defaultValue="America/Los_Angeles">
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
  detail: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        <p>{detail}</p>
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

function DashboardView() {
  const { proposal, tasks, history } = usePlanPilot();
  const todaySessions = proposal.sessions.filter((session) =>
    localDateKey(new Date(session.start)) === localDateKey(),
  );
  const shownSessions = todaySessions;
  if (tasks.length === 0 && proposal.sessions.length === 0 && history.length === 0) {
    return (
      <>
        <PageHeading
          eyebrow="EMPTY WORKSPACE"
          title="Start with a clean plan."
          detail="There are no imported responsibilities, proposed sessions, or history yet. Add your responsibilities to build a plan."
        />
        <EmptyState
          icon={Sparkles}
          title="Your workspace is clear"
          detail="Paste an assignment sheet, checklist, or email to see exactly what PlanPilot extracts and schedules."
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
        eyebrow={formatToday(true).toUpperCase()}
        title="Your plan at a glance."
        detail={proposal.planHealth.summary}
        actions={
          <Link href="/import" className="button button-primary button-md">
            <Plus size={16} /> Add responsibilities
          </Link>
        }
      />
      <div className="dashboard-grid">
        <div className="dashboard-main">
          <PlanHealthPanel />
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Today’s plan</h2>
                <p>{shownSessions.reduce((sum, session) => sum + session.minutes, 0)} focused minutes across {shownSessions.length} sessions</p>
              </div>
              <Link href="/schedule">View week <ArrowRight size={15} /></Link>
            </div>
            <div className="today-list">
              {shownSessions.length === 0 && (
                <p className="open-day">No sessions are scheduled for today.</p>
              )}
              {shownSessions.map((session, index) => (
                <article key={session.id} className="today-item">
                  <div className="today-time">
                    <strong>{formatTime(session.start)}</strong>
                    <span>{formatTime(session.end)}</span>
                  </div>
                  <i className={index === 0 ? "blue" : index === 1 ? "green" : "amber"} />
                  <div className="today-detail">
                    <div>
                      <strong>{session.title}</strong>
                      <Badge tone={session.status === "approved" ? "success" : "neutral"}>
                        {session.status}
                      </Badge>
                    </div>
                    <p>{session.explanation}</p>
                  </div>
                  <button aria-label={`Open ${session.title}`}><ChevronRight size={18} /></button>
                </article>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="panel-heading">
              <div><h2>Upcoming deadlines</h2><p>Dates stay date-only when no time was stated.</p></div>
              <Link href="/tasks/review">All tasks <ArrowRight size={15} /></Link>
            </div>
            <div className="deadline-list">
              {tasks.filter((task) => task.dueDate).slice(0, 3).map((task) => (
                <article key={task.id}>
                  <div className="date-tile">
                    <span>{shortDate(task.dueDate).split(" ")[0]}</span>
                    <strong>{shortDate(task.dueDate).split(" ")[1]}</strong>
                  </div>
                  <div><strong>{task.title}</strong><p>{task.estimatedMinutes} min estimated · {task.category}</p></div>
                  <Badge tone={task.priority === "urgent" ? "danger" : "neutral"}>{task.priority}</Badge>
                </article>
              ))}
            </div>
          </section>
        </div>
        <aside className="dashboard-side">
          <section className="risk-panel">
            <span className="risk-icon"><AlertTriangle size={20} /></span>
            <Badge tone="warning">Needs a decision</Badge>
            <h2>{proposal.planHealth.unscheduledMinutes} minutes do not fit yet</h2>
            <p>{proposal.unschedulable[0]?.explanation ?? "An uncertain task is waiting for review."}</p>
            <div className="risk-option">
              <span>Best option</span>
              <strong>Open Saturday after 1 PM</strong>
              <small>Adds enough capacity while keeping 15% buffer.</small>
            </div>
            <Link href="/schedule" className="button button-secondary button-md">
              Review options <ArrowRight size={15} />
            </Link>
          </section>
          <section className="panel side-panel">
            <div className="panel-heading">
              <div><h2>Recent changes</h2><p>Meaningful updates only</p></div>
            </div>
            <div className="mini-history">
              {history.slice(0, 3).map((item) => (
                <article key={item.id}>
                  <span><PencilLine size={15} /></span>
                  <div><strong>{item.title}</strong><p>{item.at}</p></div>
                </article>
              ))}
            </div>
            <Link href="/changes" className="full-link">View change history <ArrowRight size={14} /></Link>
          </section>
          <section className="completion-card">
            <span><CheckCircle2 size={20} /></span>
            <div><strong>135 min completed this week</strong><p>One gym session and two study blocks.</p></div>
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
    importState,
    extractionMode,
    importError,
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
  const latestLocalEstimateCount = latestImportedTasks.filter(
    (task) => task.effortEstimateSource === "heuristic",
  ).length;
  const [tab, setTab] = useState<"paste" | "txt">("paste");
  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.toLocaleLowerCase().endsWith(".txt")) {
      setImportText("");
      return;
    }
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
          <div className="tab-list" role="tablist">
            <button className={tab === "paste" ? "active" : ""} onClick={() => setTab("paste")} role="tab">
              <FileText size={16} /> Paste text
            </button>
            <button className={tab === "txt" ? "active" : ""} onClick={() => setTab("txt")} role="tab">
              <Upload size={16} /> TXT file
            </button>
          </div>
          {tab === "paste" ? (
            <label className="textarea-label">
              Source text
              <textarea
                value={importText}
                onChange={(event) => setImportText(event.target.value)}
                placeholder="Paste an assignment sheet, email, or checklist…"
              />
              <span>{importText.length.toLocaleString()} characters · Your text remains editable if extraction fails.</span>
            </label>
          ) : (
            <label className="file-drop">
              <Upload size={25} />
              <strong>Choose a TXT file</strong>
              <span>Plain text only · up to 100 KB</span>
              <input type="file" accept=".txt,text/plain" onChange={handleFile} />
            </label>
          )}
          <div className="future-formats">
            <span>More formats</span>
            <button disabled title="PDF extraction is a future capability"><FileText size={15} /> PDF <Badge>Coming later</Badge></button>
            <button disabled title="Image OCR is a future capability"><Upload size={15} /> Image or screenshot <Badge>Coming later</Badge></button>
          </div>
          <div className="import-actions">
            <p><ShieldCheck size={16} /> Dates and times are never guessed when absent.</p>
            <Button size="lg" onClick={analyzeText} disabled={!importText.trim() || importState === "loading"}>
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
        {importState === "error" && importError && <ErrorState message={importError} onRetry={analyzeText} />}
        {importState === "success" && (
          <div className="state-card state-success">
            <CheckCircle2 size={20} />
            <div>
              <strong>
                {latestImportedTasks.length} {latestImportedTasks.length === 1 ? "responsibility" : "responsibilities"} interpreted this time
              </strong>
              <p>
                {latestReviewCount} need a quick review before scheduling. {" "}
                {extractionMode !== "local"
                  ? latestLocalEstimateCount > 0
                    ? `${extractionMode === "gemini" ? "Gemini" : "OpenAI"} interpreted the list; ${latestLocalEstimateCount} ${latestLocalEstimateCount === 1 ? "item used a" : "items used"} fast local fallback estimate${latestLocalEstimateCount === 1 ? "" : "s"}.`
                    : `Effort and useful session length were estimated by ${extractionMode === "gemini" ? "Gemini" : "OpenAI"}.`
                  : "Local estimates were used because AI is not connected."}
              </p>
            </div>
            <Link className="button button-primary button-sm" href="/tasks/review">Review tasks <ArrowRight size={14} /></Link>
          </div>
        )}
      </div>
    </>
  );
}

export function TaskReviewCard({ task }: { task: ExtractedTask }) {
  const { updateTask, approveTask, deleteTask } = usePlanPilot();
  const [expanded, setExpanded] = useState(task.reviewRequired ?? false);
  const [addingTimeFor, setAddingTimeFor] = useState<DayOfWeek>();
  const timingSummary = taskTimingSummary(task);
  const schedulingPreference = taskSchedulingPreference(task);
  const customPreferenceWindow =
    task.schedulingConstraints?.preferredTimeWindows?.[0] ?? {
      start: "09:00",
      end: "17:00",
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
          </div>
          <input
            className="task-title-input"
            value={task.title}
            aria-label="Task title"
            onChange={(event) => updateTask(task.id ?? "", { title: event.target.value })}
          />
          <FieldConfidenceIndicator label="Title" confidence={task.fieldConfidence.title} />
        </div>
        <button className="icon-button" onClick={() => setExpanded(!expanded)} aria-label={expanded ? "Collapse task" : "Edit task"}>
          <PencilLine size={17} />
        </button>
        <button className="icon-button" onClick={() => deleteTask(task.id ?? "")} aria-label={`Delete ${task.title}`}>
          <Trash2 size={17} />
        </button>
      </div>
      <div className="source-quote">
        <span>From your source</span>
        <p>“{task.sourceText}”</p>
      </div>
      <div className="task-field-summary">
        {task.recurrence?.mode === "fixed_times" ? (
          <div>
            <span>Recurring schedule</span>
            <strong>{recurrenceSummary(task)}</strong>
            <FieldConfidenceIndicator label="Recurrence" confidence={task.fieldConfidence.recurrence} />
          </div>
        ) : (
          <div>
            <span>Deadline</span>
            <strong>{task.dueDate ? `${shortDate(task.dueDate)}${task.dueTime ? ` at ${task.dueTime}` : " · time not specified"}` : "Not specified"}</strong>
            <FieldConfidenceIndicator label="Deadline" confidence={task.fieldConfidence.dueDate} />
          </div>
        )}
        <div>
          <span>Effort</span>
          <strong>{task.estimatedMinutes ? `${task.estimatedMinutes} minutes` : "Not estimated"}</strong>
          {task.effortEstimateSource && (
            <Badge tone={task.effortEstimateSource === "ai" ? "success" : "neutral"}>
              {task.effortEstimateSource === "ai"
                ? "AI estimate"
                : task.effortEstimateSource === "stated"
                  ? "Stated duration"
                  : "Local estimate"}
            </Badge>
          )}
          {task.effortEstimateRationale && <p>{task.effortEstimateRationale}</p>}
          <FieldConfidenceIndicator label="Effort" confidence={task.fieldConfidence.estimatedMinutes} />
        </div>
        <div>
          <span>Priority</span>
          <strong className="capitalize">{task.priority}</strong>
          <FieldConfidenceIndicator label="Priority" confidence={task.fieldConfidence.priority} />
        </div>
        <div>
          <span>Energy</span>
          <strong className="capitalize">{task.energyDemand}</strong>
        </div>
        {timingSummary && (
          <div>
            <span>Scheduling</span>
            <strong>{timingSummary}</strong>
          </div>
        )}
      </div>
      <div className="task-preference-editor">
        <label>
          Scheduling preference <span>(optional)</span>
          <select
            aria-label={`Scheduling preference for ${task.title}`}
            disabled={schedulingPreference === "fixed"}
            value={schedulingPreference}
            onChange={(event) =>
              updateTask(task.id ?? "", {
                schedulingConstraints: setTaskSchedulingPreference(
                  task,
                  event.target.value as TaskSchedulingPreference,
                ),
              })
            }
          >
            {schedulingPreference === "fixed" && (
              <option value="fixed">Fixed by event schedule</option>
            )}
            {TASK_SCHEDULING_PREFERENCE_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
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
            ? "This task already has an exact scheduled time."
            : "A soft preference: deadlines and hard availability still come first."}
        </p>
      </div>
      {task.dueDate && !task.dueTime && (
        <div className="assumption-note">
          <Info size={15} />
          <span><strong>Planning assumption only:</strong> feasibility uses the end of your waking day. No due time will be saved.</span>
        </div>
      )}
      {task.missingInformation.length > 0 && (
        <div className="missing-row">
          {task.missingInformation.map((item) => <Badge tone="warning" key={item}>{item}</Badge>)}
        </div>
      )}
      {expanded && (
        <div className="task-edit-grid">
          <label>
            Task type
            <select
              value={task.taskType}
              onChange={(event) => {
                const taskType = event.target.value as ExtractedTask["taskType"];
                updateTask(task.id ?? "", {
                  taskType,
                  recurrence:
                    taskType === "recurring_goal" ? task.recurrence : undefined,
                });
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
          <label>
            Due date
            <input type="date" value={task.dueDate ?? ""} onChange={(event) => updateTask(task.id ?? "", { dueDate: event.target.value || undefined })} />
          </label>
          <label>
            Due time
            <input type="time" value={task.dueTime ?? ""} onChange={(event) => updateTask(task.id ?? "", { dueTime: event.target.value || undefined })} />
          </label>
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
  const allReviewCount = tasks.filter((task) => task.reviewRequired).length;
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
            onClick={() => scopedTasks.filter((task) => task.reviewRequired).forEach((task) => approveTask(task.id ?? ""))}
            disabled={reviewCount === 0}
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
        <div className="filter-tabs">
          {([...(latestTasks.length > 0 ? ["recent" as const] : []), "review", "ready", "all"] as const).map((item) => (
            <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>
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

export function UnschedulableTaskCard({ task }: { task: UnschedulableTask }) {
  return (
    <article className="unschedulable-card">
      <span><AlertTriangle size={18} /></span>
      <div>
        <div><strong>{task.title}</strong><Badge tone="warning">{task.unscheduledMinutes} min unplaced</Badge></div>
        <p>{task.explanation}</p>
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
}: {
  session: PlannedSession;
  selectable?: boolean;
  reasonExpanded?: boolean;
  onReasonExpandedChange?: (expanded: boolean) => void;
}) {
  const {
    toggleSessionLock,
    rejectSession,
    requestAnotherTime,
    selectedSessionIds,
    toggleSelectedSession,
    approveSession,
  } = usePlanPilot();
  const actionable = session.status === "proposed" || session.status === "approved";
  const statusLabel = session.status.replace("_", " ");
  const isOverdue = session.reasonCodes.includes("OVERDUE_RECOVERY");
  return (
    <article
      className={`schedule-session ${session.status === "approved" ? "session-approved" : ""} ${isOverdue ? "session-overdue" : ""}`}
      draggable={actionable && !session.locked}
      onDragEnd={() => actionable && !session.locked && requestAnotherTime(session.id)}
    >
      <div className="session-top">
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
        <div className="session-time">
          <strong>{formatTime(session.start)}–{formatTime(session.end)}</strong>
          <span>{session.minutes} min</span>
        </div>
        {isOverdue && (
          <span
            className="session-overdue-badge"
            title="This work is scheduled after its stated deadline"
          >
            <AlertTriangle size={11} aria-hidden="true" />
            Overdue
          </span>
        )}
        <button
          className="icon-button"
          onClick={() => toggleSessionLock(session.id)}
          aria-label={session.locked ? "Unlock session" : "Lock session"}
        >
          {session.locked ? <Lock size={15} /> : <LockOpen size={15} />}
        </button>
      </div>
      <h3>{session.title}</h3>
      <ScheduleReason
        reasons={session.reasonCodes}
        explanation={session.explanation}
        expanded={reasonExpanded}
        onExpandedChange={onReasonExpandedChange}
      />
      <div className="session-actions">
        {session.status === "proposed" ? (
          <button onClick={() => approveSession(session.id)}><Check size={13} /> Approve</button>
        ) : <Badge tone={session.status === "approved" || session.status === "completed" ? "success" : "neutral"}><Check size={12} /> {statusLabel}</Badge>}
        {actionable && <button onClick={() => requestAnotherTime(session.id)} disabled={session.locked}><RotateCcw size={13} /> Another time</button>}
        {actionable && <button onClick={() => rejectSession(session.id)}><X size={13} /> Reject</button>}
      </div>
    </article>
  );
}

function scheduleColumns(sessions: PlannedSession[]) {
  const base = new Date(`${localDateKey()}T12:00:00Z`);
  const latest = sessions.reduce((value, session) => {
    const date = new Date(`${localDateKey(new Date(session.start))}T12:00:00Z`);
    return date > value ? date : value;
  }, base);
  const visibleDays = Math.min(
    35,
    Math.max(5, Math.round((latest.getTime() - base.getTime()) / (24 * 60 * 60_000)) + 1),
  );
  return Array.from({ length: visibleDays }, (_, offset) => {
    const date = new Date(base);
    date.setUTCDate(base.getUTCDate() + offset);
    const key = date.toISOString().slice(0, 10);
    return {
      date: key,
      label: new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(date),
      day: new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: "UTC" }).format(date),
      range: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date),
    };
  });
}

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
    requestAnotherTime,
    canUndoSchedule,
    undoScheduleLabel,
    undoSchedule,
  } = usePlanPilot();
  const [mode, setMode] = useState<"week" | "list">("week");
  const [scope, setScope] = useState<"recent" | "all">("all");
  const [expandedReasonIds, setExpandedReasonIds] = useState<string[]>([]);
  const latestTaskIds = new Set(lastImportedTaskIds);
  const visibleSessions = proposal.sessions.filter(
    (session) => scope === "all" || latestTaskIds.has(session.taskId),
  );
  const visibleUnschedulable = proposal.unschedulable.filter(
    (task) => scope === "all" || latestTaskIds.has(task.taskId),
  );
  const weekColumns = scheduleColumns(visibleSessions);
  const allReasonsExpanded =
    visibleSessions.length > 0 &&
    visibleSessions.every((session) => expandedReasonIds.includes(session.id));
  const toggleAllReasons = () => {
    setExpandedReasonIds(
      allReasonsExpanded ? [] : visibleSessions.map((session) => session.id),
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
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const sessionId = event.dataTransfer.getData("text/plain");
    if (sessionId) requestAnotherTime(sessionId);
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
          icon={CalendarDays}
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
        eyebrow="PROPOSED SCHEDULE · VERSION 3"
        title="A realistic plan for the weeks ahead."
        detail={
          scope === "recent"
            ? "Showing the latest import. Earlier commitments still protect their time without cluttering this view."
            : "Drag unlocked sessions, request another time, or approve only what works. Invalid placements are rejected."
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
      <div className="schedule-toolbar">
        <div className="view-toggle">
          <button className={mode === "week" ? "active" : ""} onClick={() => setMode("week")}><CalendarDays size={15} /> Timeline</button>
          <button className={mode === "list" ? "active" : ""} onClick={() => setMode("list")}><LayoutList size={15} /> Task list</button>
        </div>
        {lastImportedTaskIds.length > 0 && (
          <div className="view-toggle schedule-scope-toggle" aria-label="Schedule responsibility scope">
            <button className={scope === "recent" ? "active" : ""} onClick={() => setScope("recent")}>Just added</button>
            <button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>All responsibilities</button>
          </div>
        )}
        <button
          type="button"
          className="reasoning-all-button"
          onClick={toggleAllReasons}
          aria-label={`${allReasonsExpanded ? "Collapse" : "Expand"} all scheduling reasoning and explanations`}
        >
          {allReasonsExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {allReasonsExpanded ? "Collapse all" : "Expand all"}
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
        <span className="schedule-range">{weekColumns[0].range} – {weekColumns.at(-1)?.range}</span>
      </div>
      {mode === "week" ? (
        <div
          className="week-board"
          style={{ gridTemplateColumns: `repeat(${weekColumns.length}, minmax(180px, 1fr))` }}
        >
          {weekColumns.map((day) => {
            const sessions = visibleSessions.filter(
              (session) =>
                new Intl.DateTimeFormat("en-CA", {
                  timeZone: "America/Los_Angeles",
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                }).format(new Date(session.start)) === day.date,
            );
            return (
              <div className="week-column" key={day.date} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
                <header className={day.date === localDateKey() ? "today" : ""}>
                  <span>{day.label}</span><strong>{day.day}</strong>
                  {day.date === localDateKey() && <small>Today</small>}
                </header>
                <div className="day-capacity"><i style={{ width: `${Math.min(100, sessions.length * 24)}%` }} /><span>{sessions.reduce((sum, session) => sum + session.minutes, 0)}m planned</span></div>
                <div className="day-sessions">
                  {sessions.map((session) => (
                    <div key={session.id} onDragStart={(event) => event.dataTransfer.setData("text/plain", session.id)}>
                      <ScheduleSessionCard
                        session={session}
                        reasonExpanded={expandedReasonIds.includes(session.id)}
                        onReasonExpandedChange={(expanded) =>
                          setReasonExpanded(session.id, expanded)
                        }
                      />
                    </div>
                  ))}
                  {sessions.length === 0 && <span className="open-day">Open capacity</span>}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="schedule-list-view">
          {visibleSessions.map((session) => (
            <div key={session.id}>
              <span className="list-day">{formatDay(session.start, true)}</span>
              <ScheduleSessionCard
                session={session}
                reasonExpanded={expandedReasonIds.includes(session.id)}
                onReasonExpandedChange={(expanded) =>
                  setReasonExpanded(session.id, expanded)
                }
              />
            </div>
          ))}
        </div>
      )}
      <div className="schedule-bottom-grid">
        <section className="panel">
          <div className="panel-heading"><div><h2>Work that does not fit yet</h2><p>No tasks are quietly squeezed into invalid time.</p></div></div>
          <div className="unschedulable-list">
            {visibleUnschedulable.map((task) => <UnschedulableTaskCard task={task} key={task.taskId} />)}
            {visibleUnschedulable.length === 0 && (
              <p className="open-day">Everything in this view fits.</p>
            )}
          </div>
        </section>
        <section className="export-panel">
          <span><CalendarDays size={21} /></span>
          <div>
            <Badge tone="info">Mock calendar</Badge>
            <h2>Ready to export approved sessions?</h2>
            <p>Only approved sessions are created. Imported events are never modified.</p>
            <Button onClick={exportApprovedSessions} disabled={exportState === "loading"}>
              {exportState === "loading" ? <RefreshCw className="spin" size={16} /> : <Cloud size={16} />}
              Export approved
            </Button>
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
            icon={CheckCircle2}
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
    timeZone: "America/Los_Angeles",
    weekday: "short",
  }).format(startDate).toUpperCase();
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
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
          <div className="outcome-grid">
            <button className={selectedOutcome === "completed" ? "selected success" : ""} onClick={() => { setActiveSessionId(next.id); setOutcome("completed"); }}><CheckCircle2 size={20} /><strong>{nextCheckIn.phase === "in_progress" ? "Finish early" : "Completed"}</strong><span>All planned work done</span></button>
            <button className={selectedOutcome === "partial" ? "selected" : ""} onClick={() => { setActiveSessionId(next.id); setOutcome("partial"); setMinutes(selectedMinutes); }}><PanelLeft size={20} /><strong>Partially completed</strong><span>Some effort remains</span></button>
            <button disabled={nextCheckIn.phase === "in_progress"} className={selectedOutcome === "missed" ? "selected warning" : ""} onClick={() => { setActiveSessionId(next.id); setOutcome("missed"); }}><RotateCcw size={20} /><strong>Missed</strong><span>{nextCheckIn.phase === "in_progress" ? "Available after session end" : "Move the work forward"}</span></button>
            <button className={selectedOutcome === "unnecessary" ? "selected" : ""} onClick={() => { setActiveSessionId(next.id); setOutcome("unnecessary"); }}><X size={20} /><strong>No longer needed</strong><span>Remove remaining work</span></button>
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
          icon={History}
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
            <div className="settings-heading"><span><CalendarDays size={19} /></span><div><h2>Google Calendar</h2><p>Read busy time and export approved PlanPilot sessions.</p></div></div>
            <div className="connection-row">
              <div className="google-mark">G</div>
              <div><strong>Google Calendar</strong><p>Not connected · Mock calendar is active</p></div>
              <Badge>OAuth keys required</Badge>
              <button disabled className="button button-secondary button-sm">Connect</button>
            </div>
            <p className="settings-footnote"><ShieldCheck size={14} /> Production OAuth stays server-side, requests calendar event scope, and encrypts refresh tokens. Imported events are read-only.</p>
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
            <p className="privacy-copy">PlanPilot sends imported text to OpenAI only when the OpenAI provider is explicitly configured; mock mode keeps extraction local to this app. No claim is made here about model training or provider retention beyond the configured provider’s policy.</p>
          </section>
        </div>
      </div>
    </>
  );
}

export default function PlanPilotApp({ view }: { view: PlanPilotView }) {
  if (view === "landing") return <LandingView />;
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
