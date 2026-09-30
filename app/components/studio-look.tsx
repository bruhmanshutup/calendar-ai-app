"use client";

/**
 * "Studio" look for the signed-in app: pure black stage, liquid-metal pills,
 * one italic serif word per heading, and a different silver wave per tab.
 *
 * Everything here is optional decoration. The look is switched with the
 * <html data-look="studio|classic"> attribute (saved in localStorage), and
 * all of its styling lives in app/studio-look.css. To remove it for good:
 * delete this file, app/studio-look.css, and the lines that reference them.
 */

import { useSyncExternalStore } from "react";
import { Palette } from "lucide-react";

export type AppLook = "studio" | "classic";

const LOOK_STORAGE_KEY = "planpilot-look";
const LOOK_EVENT = "planpilot-look-change";

function readLook(): AppLook {
  return document.documentElement.dataset.look === "classic" ? "classic" : "studio";
}

function subscribeLook(onChange: () => void) {
  window.addEventListener(LOOK_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(LOOK_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useAppLook(): AppLook {
  return useSyncExternalStore(subscribeLook, readLook, () => "studio");
}

export function setAppLook(look: AppLook) {
  document.documentElement.dataset.look = look;
  try {
    localStorage.setItem(LOOK_STORAGE_KEY, look);
  } catch {
    // Storage can be blocked; the look still applies for this visit.
  }
  window.dispatchEvent(new Event(LOOK_EVENT));
}

/** Menu row that flips between the studio and classic looks. */
export function LookToggle({ onDone, menuItem = true }: { onDone?: () => void; menuItem?: boolean }) {
  const look = useAppLook();
  return (
    <button
      type="button"
      role={menuItem ? "menuitem" : undefined}
      className="look-toggle"
      onClick={() => {
        setAppLook(look === "studio" ? "classic" : "studio");
        onDone?.();
      }}
    >
      <Palette size={16} aria-hidden="true" />
      <span>{look === "studio" ? "Switch to classic look" : "Switch to studio look"}</span>
    </button>
  );
}

/** The four-point star used on heading badges. */
export function StudioSparkle({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.6C12.55 2.6 12.88 3.15 13.08 4.7c.62 4.7 1.52 5.6 6.22 6.22 1.55.2 2.1.53 2.1 1.08s-.55.88-2.1 1.08c-4.7.62-5.6 1.52-6.22 6.22-.2 1.55-.53 2.1-1.08 2.1s-.88-.55-1.08-2.1c-.62-4.7-1.52-5.6-6.22-6.22C3.15 12.88 2.6 12.55 2.6 12s.55-.88 2.1-1.08c4.7-.62 5.6-1.52 6.22-6.22C11.12 3.15 11.45 2.6 12 2.6Z" />
    </svg>
  );
}

type WaveShape = {
  /** Number of strands. */
  lines: number;
  /** Main swell height and how many full cycles span the screen. */
  amplitude: number;
  cycles: number;
  /** A second, faster ripple layered on top. */
  ripple: number;
  rippleCycles: number;
  /** Vertical gap and phase twist between neighbouring strands. */
  spread: number;
  twist: number;
  /** Where the bundle sits (0 = top, 1 = bottom) and seconds per loop. */
  center: number;
  seconds: number;
};

// One personality per tab.
const WAVES: Record<string, WaveShape> = {
  // Overview: a slow ocean swell.
  dashboard: { lines: 7, amplitude: 34, cycles: 1, ripple: 8, rippleCycles: 3, spread: 9, twist: 0.28, center: 0.5, seconds: 38 },
  // Add: choppy water, like a pile of unsorted notes.
  import: { lines: 9, amplitude: 16, cycles: 3, ripple: 7, rippleCycles: 7, spread: 8, twist: 0.5, center: 0.52, seconds: 26 },
  // Tasks: tightly stacked lines, like the page edges of a textbook.
  review: { lines: 16, amplitude: 9, cycles: 1, ripple: 2, rippleCycles: 4, spread: 4.5, twist: 0.06, center: 0.46, seconds: 60 },
  // Schedule: a twisting ribbon, like a bookmark.
  schedule: { lines: 6, amplitude: 26, cycles: 2, ripple: 4, rippleCycles: 5, spread: 6, twist: 0.95, center: 0.5, seconds: 32 },
  // Daily review: a steady pulse.
  "daily-review": { lines: 4, amplitude: 12, cycles: 5, ripple: 10, rippleCycles: 1, spread: 10, twist: 0.2, center: 0.5, seconds: 22 },
  // Changes: a long, calm timeline.
  changes: { lines: 3, amplitude: 14, cycles: 1, ripple: 3, rippleCycles: 2, spread: 14, twist: 0.4, center: 0.55, seconds: 48 },
  // Settings: fine, even tuning lines.
  settings: { lines: 6, amplitude: 5, cycles: 6, ripple: 2, rippleCycles: 12, spread: 7, twist: 0.15, center: 0.5, seconds: 40 },
};

const WAVE_WIDTH = 1440;
const WAVE_HEIGHT = 300;

function strandPath(shape: WaveShape, index: number): string {
  const offset = (index - (shape.lines - 1) / 2) * shape.spread;
  const baseY = WAVE_HEIGHT * shape.center + offset;
  const phase = index * shape.twist;
  const points: string[] = [];
  // Two screen-widths long so sliding left by one width loops seamlessly.
  for (let x = 0; x <= WAVE_WIDTH * 2; x += 16) {
    const t = (x / WAVE_WIDTH) * Math.PI * 2;
    const y =
      baseY +
      shape.amplitude * Math.sin(t * shape.cycles + phase) +
      shape.ripple * Math.sin(t * shape.rippleCycles + phase * 1.7);
    points.push(`${x === 0 ? "M" : "L"}${x} ${Math.round(y * 10) / 10}`);
  }
  return points.join(" ");
}

/** A silver, slowly drifting wave drawn behind the page header. Shape depends on the tab. */
export function TabWave({ view }: { view: string }) {
  const shape = WAVES[view] ?? WAVES.dashboard;
  return (
    <div className={`tab-wave tab-wave-${view}`} aria-hidden="true">
      <svg viewBox={`0 0 ${WAVE_WIDTH} ${WAVE_HEIGHT}`} preserveAspectRatio="none">
        <g className="tab-wave-drift" style={{ animationDuration: `${shape.seconds}s` }}>
          {Array.from({ length: shape.lines }, (_, index) => (
            <path
              key={index}
              d={strandPath(shape, index)}
              fill="none"
              stroke="#e3e6ec"
              strokeWidth={index === Math.floor(shape.lines / 2) ? 1.4 : 0.8}
              strokeOpacity={0.35 + 0.6 * (1 - Math.abs(index - (shape.lines - 1) / 2) / shape.lines)}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}
