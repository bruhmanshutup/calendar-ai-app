"use client";

import { lazy, Suspense, useState, useSyncExternalStore } from "react";
import type { OrbitBlock } from "./plan-orbit-scene";

export type { OrbitBlock };

/**
 * Visual helpers for PlanPilot's "Night flight" design:
 *  - PlanOrbit: the interactive 3D day ring (lazy-loaded Three.js scene with
 *    an SVG fallback for reduced-motion, no-WebGL, and while loading)
 *  - RouteIllustration: SVG art for empty states
 *  - Skeleton pieces for loading states
 */

const PlanOrbitScene = lazy(() => import("./plan-orbit-scene"));

// Media queries and environment checks are read through useSyncExternalStore
// so the server render stays deterministic and no state is set in effects.
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

const subscribeNever = () => () => {};
export function useIsClient(): boolean {
  return useSyncExternalStore(subscribeNever, () => true, () => false);
}

let webglSupport: boolean | undefined;
function detectWebGL(): boolean {
  if (webglSupport === undefined) {
    try {
      const canvas = document.createElement("canvas");
      webglSupport = Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
    } catch {
      webglSupport = false;
    }
  }
  return webglSupport;
}
export function useWebGLSupport(): boolean {
  return useSyncExternalStore(subscribeNever, detectWebGL, () => false);
}

const BackdropScene = lazy(() => import("./backdrop-scene"));

/** Calm 3D star field + rings behind the app screens (desktop only). */
export function AppBackdrop() {
  const reduced = usePrefersReducedMotion();
  const small = useMediaQuery("(max-width: 850px)");
  const client = useIsClient();
  const webgl = useWebGLSupport();
  if (!client || !webgl || small) return null;
  return (
    <div className="app-backdrop" aria-hidden="true">
      <Suspense fallback={null}>
        <BackdropScene reducedMotion={reduced} />
      </Suspense>
    </div>
  );
}

const round2 = (value: number) => Math.round(value * 100) / 100;

const DEMO_BLOCKS: OrbitBlock[] = [
  { label: "Chemistry review", start: 0.34, width: 0.05, tone: "violet" },
  { label: "Lecture", start: 0.44, width: 0.06, tone: "cyan" },
  { label: "Essay draft", start: 0.58, width: 0.07, tone: "coral" },
  { label: "Gym", start: 0.74, width: 0.04, tone: "amber" },
];

/** Static SVG version of the ring for fallbacks. */
export function OrbitFallback({ blocks = DEMO_BLOCKS, progress = 0.5 }: { blocks?: OrbitBlock[]; progress?: number }) {
  const r = 78;
  const cx = 110;
  const cy = 110;
  const arc = (start: number, width: number) => {
    const a0 = start * Math.PI * 2 - Math.PI / 2;
    const a1 = (start + width) * Math.PI * 2 - Math.PI / 2;
    const x0 = round2(cx + Math.cos(a0) * r);
    const y0 = round2(cy + Math.sin(a0) * r);
    const x1 = round2(cx + Math.cos(a1) * r);
    const y1 = round2(cy + Math.sin(a1) * r);
    return `M ${x0} ${y0} A ${r} ${r} 0 ${width > 0.5 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const na = progress * Math.PI * 2 - Math.PI / 2;
  const nx = round2(cx + Math.cos(na) * r);
  const ny = round2(cy + Math.sin(na) * r);
  return (
    <svg className="orbit-fallback" viewBox="0 0 220 220" aria-hidden="true">
      <defs>
        <radialGradient id="orbit-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#7d72b0" stopOpacity="0.35" />
          <stop offset="1" stopColor="#7d72b0" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={cx} cy={cy} r={104} fill="url(#orbit-glow)" />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#7d72b0" strokeWidth="3" opacity="0.8" />
      {blocks.map((block) => (
        <path key={block.label} d={arc(block.start, block.width)} fill="none" strokeWidth="12" strokeLinecap="round" className={`orbit-arc orbit-arc-${block.tone}`} />
      ))}
      <circle cx={nx} cy={ny} r="7" fill="#fff" />
      <circle cx={nx} cy={ny} r="14" fill="#dcd6ee" opacity="0.3" />
    </svg>
  );
}

/** Static clock face for phones / no-3D on the landing page. */
export function ClockFallback() {
  const hours = Array.from({ length: 12 }, (_, index) => index + 1);
  const at = (value: number, radius: number) => {
    const angle = (value / 12) * Math.PI * 2;
    return { x: round2(110 + Math.sin(angle) * radius), y: round2(110 - Math.cos(angle) * radius) };
  };
  const minute = at(2, 72);
  const hour = at(10.2, 46);
  return (
    <svg className="orbit-fallback clock-fallback" viewBox="0 0 220 220" aria-hidden="true">
      <circle cx="110" cy="110" r="100" fill="#2a2836" stroke="#4a4462" strokeWidth="6" />
      <circle cx="110" cy="110" r="90" fill="#4a4462" />
      {hours.map((value) => {
        const inner = at(value, value % 3 === 0 ? 76 : 80);
        const outer = at(value, 87);
        const label = at(value, 64);
        return (
          <g key={value}>
            <line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} stroke="#e7dfcf" strokeWidth={value % 3 === 0 ? 3 : 1.5} strokeLinecap="round" opacity="0.8" />
            <text x={label.x} y={label.y} fill="#e7dfcf" fontSize="12" fontWeight="600" textAnchor="middle" dominantBaseline="central" opacity="0.85">
              {value}
            </text>
          </g>
        );
      })}
      <line x1="110" y1="110" x2={hour.x} y2={hour.y} stroke="#d6c39a" strokeWidth="6" strokeLinecap="round" />
      <line x1="110" y1="110" x2={minute.x} y2={minute.y} stroke="#d6c39a" strokeWidth="4" strokeLinecap="round" />
      <circle cx="110" cy="110" r="6" fill="#d6c39a" />
    </svg>
  );
}

export function PlanOrbit({
  blocks,
  progress = 0.5,
  compact = false,
  caption,
  className = "",
  demoWhenEmpty = true,
}: {
  blocks?: OrbitBlock[];
  progress?: number;
  compact?: boolean;
  caption?: string;
  className?: string;
  demoWhenEmpty?: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const small = useMediaQuery("(max-width: 700px)");
  const coarse = useMediaQuery("(hover: none)");
  const webgl = useWebGLSupport();
  const mounted = useIsClient();
  const [hovered, setHovered] = useState<string>();

  const sceneBlocks = blocks && blocks.length > 0 ? blocks : demoWhenEmpty ? DEMO_BLOCKS : [];
  // Phones get the lightweight SVG; everything else gets the live scene.
  const useScene = mounted && webgl && !small;
  return (
    <div className={`orbit ${compact ? "orbit-compact" : ""} ${className}`}>
      <div className="orbit-stage">
        {useScene ? (
          <Suspense fallback={<OrbitFallback blocks={sceneBlocks} progress={progress} />}>
            <PlanOrbitScene
              blocks={sceneBlocks}
              progress={progress}
              reducedMotion={reduced}
              interactive={!coarse}
              compact={compact}
              onHoverBlock={setHovered}
            />
          </Suspense>
        ) : (
          <OrbitFallback blocks={sceneBlocks} progress={progress} />
        )}
        <div className="orbit-hud" aria-hidden="true">
          <span className={`orbit-chip ${hovered ? "is-live" : ""}`}>{hovered ?? caption ?? "Drag to spin · hover a block"}</span>
        </div>
      </div>
    </div>
  );
}

/** Dashed route with waypoints for empty states. */
export function RouteIllustration({ variant = "route" }: { variant?: "route" | "clear" | "history" | "inbox" }) {
  return (
    <svg className="illustration" viewBox="0 0 220 120" role="img" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="illu-sky" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.28" />
          <stop offset="1" stopColor="var(--accent-2)" stopOpacity="0.08" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="220" height="120" rx="20" fill="url(#illu-sky)" />
      <path d="M12 96 Q 60 40 110 70 T 208 30" className="illu-path" />
      {variant === "route" && (
        <>
          <circle cx="12" cy="96" r="6" className="illu-node illu-node-done" />
          <circle cx="76" cy="52" r="6" className="illu-node illu-node-done" />
          <circle cx="140" cy="66" r="7" className="illu-node illu-node-current" />
          <circle cx="208" cy="30" r="6" className="illu-node" />
          <rect x="94" y="16" width="52" height="22" rx="8" className="illu-card" />
          <rect x="102" y="22" width="26" height="4" rx="2" className="illu-card-line" />
          <rect x="102" y="29" width="36" height="3" rx="1.5" className="illu-card-line-soft" />
        </>
      )}
      {variant === "clear" && (
        <>
          <circle cx="110" cy="60" r="26" className="illu-ring" />
          <path d="M97 61 l9 9 l18 -20" className="illu-check" />
        </>
      )}
      {variant === "history" && (
        <>
          <circle cx="40" cy="80" r="5" className="illu-node illu-node-done" />
          <circle cx="90" cy="58" r="5" className="illu-node illu-node-done" />
          <circle cx="140" cy="66" r="5" className="illu-node illu-node-done" />
          <circle cx="190" cy="38" r="5" className="illu-node" />
          <rect x="24" y="24" width="60" height="12" rx="4" className="illu-card-line-soft" />
          <rect x="24" y="40" width="40" height="8" rx="3" className="illu-card-line-soft" />
        </>
      )}
      {variant === "inbox" && (
        <>
          <rect x="60" y="30" width="100" height="64" rx="12" className="illu-card" />
          <rect x="74" y="44" width="52" height="5" rx="2.5" className="illu-card-line" />
          <rect x="74" y="56" width="72" height="4" rx="2" className="illu-card-line-soft" />
          <rect x="74" y="66" width="60" height="4" rx="2" className="illu-card-line-soft" />
          <rect x="74" y="76" width="30" height="4" rx="2" className="illu-card-line-soft" />
          <circle cx="160" cy="34" r="10" className="illu-node illu-node-current" />
          <path d="M156 34 h8 M160 30 v8" className="illu-plus" />
        </>
      )}
    </svg>
  );
}

export function WaypointDots() {
  return (
    <span className="waypoint-dots" aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

export function Skeleton({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`skeleton-group ${className}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <span className="skeleton skeleton-line" key={index} style={{ width: `${100 - index * 14}%` }} />
      ))}
    </div>
  );
}

export function SkeletonPanel({ rows = 3 }: { rows?: number }) {
  return (
    <div className="panel skeleton-panel" aria-hidden="true">
      <span className="skeleton skeleton-title" />
      {Array.from({ length: rows }, (_, index) => (
        <span className="skeleton skeleton-row" key={index} />
      ))}
    </div>
  );
}
