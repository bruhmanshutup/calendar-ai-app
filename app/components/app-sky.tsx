"use client";

/**
 * Animated landscape behind the signed-in app (copy only).
 * Inspired by MotionSites' animated-background samples and the "Forecast
 * Center" sample's full-bleed sky: a time-of-day sky, mountain ridges with a
 * glowing horizon, stars and an aurora at night, a sun and clouds by day.
 * Everything is drawn in code; no photos. Styles live in app/sky.css.
 */

import { useEffect, useState } from "react";
import { DEFAULT_PREFERENCES } from "@/lib/defaults";

export type SkyPart = "dawn" | "day" | "dusk" | "night";

function partFor(hour: number): SkyPart {
  if (hour >= 5 && hour < 8) return "dawn";
  if (hour >= 8 && hour < 17) return "day";
  if (hour >= 17 && hour < 20) return "dusk";
  return "night";
}

function currentHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_PREFERENCES.timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date()),
  );
}

/** Time of day, read after mount and refreshed every few minutes. */
function useSkyPart(): SkyPart {
  const [part, setPart] = useState<SkyPart>("dusk");
  useEffect(() => {
    const tick = () => setPart(partFor(currentHour()));
    tick();
    const timer = window.setInterval(tick, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return part;
}

/** Small seeded random generator so stars land in the same places every visit. */
function seeded(seed: number) {
  let value = seed;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

const STARS = (() => {
  const random = seeded(42);
  return Array.from({ length: 110 }, () => ({
    left: Math.round(random() * 1000) / 10,
    top: Math.round(random() * 600) / 10,
    size: Math.round((0.8 + random() * 1.8) * 10) / 10,
    delay: Math.round(random() * 60) / 10,
    duration: Math.round((2.5 + random() * 4.5) * 10) / 10,
  }));
})();

const WIDTH = 1440;
const HEIGHT = 420;

/** A mountain ridge: smooth swells plus a sharper layer for peaks. */
function ridgePath(seed: number, base: number, amplitude: number, sharpness: number): string {
  const points: string[] = [];
  for (let x = 0; x <= WIDTH; x += 16) {
    const y =
      base -
      amplitude *
        (0.5 * Math.sin(x * 0.0035 + seed) +
          0.3 * Math.sin(x * 0.009 + seed * 2.3) +
          sharpness * Math.abs(Math.sin(x * 0.021 + seed * 3.1)) +
          0.08 * Math.sin(x * 0.06 + seed * 5.3));
    points.push(`L${x} ${Math.round(y * 10) / 10}`);
  }
  return `M0 ${HEIGHT} ${points.join(" ")} L${WIDTH} ${HEIGHT} Z`;
}

const RIDGES = {
  far: ridgePath(1.3, 250, 120, 0.42),
  mid: ridgePath(4.1, 305, 80, 0.26),
  near: ridgePath(7.7, 360, 46, 0.12),
};

export function AppSky() {
  const part = useSkyPart();
  return (
    <div className="app-sky" data-part={part} aria-hidden="true">
      <div className="sky-glow" />
      <div className="sky-aurora">
        <span />
        <span />
      </div>
      <div className="sky-stars">
        {STARS.map((star, index) => (
          <i
            key={index}
            style={{
              left: `${star.left}%`,
              top: `${star.top}%`,
              width: star.size,
              height: star.size,
              animationDelay: `${star.delay}s`,
              animationDuration: `${star.duration}s`,
            }}
          />
        ))}
        <b className="shooting-star" />
      </div>
      <div className="sky-orb" />
      <div className="sky-clouds">
        <span />
        <span />
        <span />
      </div>
      <svg className="sky-ridges" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="xMidYMax slice">
        <defs>
          <linearGradient id="sky-haze" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--sky-horizon)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--sky-horizon)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={RIDGES.far} fill="var(--ridge-far)" />
        <rect x="0" y="120" width={WIDTH} height="220" fill="url(#sky-haze)" />
        <path d={RIDGES.mid} fill="var(--ridge-mid)" />
        <path d={RIDGES.near} fill="var(--ridge-near)" />
      </svg>
      <div className="sky-mist" />
    </div>
  );
}
