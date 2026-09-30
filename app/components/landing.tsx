"use client";

import Link from "next/link";
import { ArrowDown, ArrowRight, Check, Sparkles, Waypoints } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import packageJson from "@/package.json";
import { ClockFallback, useIsClient, useMediaQuery, usePrefersReducedMotion, useWebGLSupport } from "./visuals";

const PlanWorldScene = lazy(() => import("./plan-world-scene"));

/**
 * LandingExperience — a scroll-driven 3D story. The world canvas is fixed
 * behind the page; each "beat" is a tall section whose copy sticks in the
 * viewport while the camera flies to the next position in the scene.
 */

function BrandLockup() {
  return (
    <Link className="brand" href="/">
      <span className="brand-mark" aria-hidden="true">
        <Waypoints size={20} strokeWidth={2.3} />
      </span>
      <span className="brand-name">PlanPilot</span>
      <span className="brand-version" title={`PlanPilot version ${packageJson.version}`}>v{packageJson.version}</span>
    </Link>
  );
}

function Loader({ visible }: { visible: boolean }) {
  return (
    <div className={`loader ${visible ? "" : "loader-done"}`} aria-hidden={!visible} role="status">
      <div className="loader-inner">
        <span className="loader-mark"><Waypoints size={26} strokeWidth={2.3} /></span>
        <div className="loader-bar"><span /></div>
        <p>Charting your week…</p>
      </div>
    </div>
  );
}

/** Glowing cursor that follows the pointer (only on devices that hover). */
function GlowCursor() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!window.matchMedia("(hover: hover)").matches) return;
    const element = ref.current;
    if (!element) return;
    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;
    let targetX = x;
    let targetY = y;
    let frame = 0;
    const move = (event: PointerEvent) => {
      targetX = event.clientX;
      targetY = event.clientY;
      element.classList.add("is-on");
      const target = event.target as Element | null;
      element.classList.toggle("is-hover", Boolean(target?.closest("a, button, [role='button'], input, textarea, select")));
      element.classList.toggle("is-grab", Boolean(target?.closest("canvas")));
    };
    const leave = () => element.classList.remove("is-on");
    const press = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest("canvas")) element.classList.add("is-grabbing");
    };
    const release = () => element.classList.remove("is-grabbing");
    const tick = () => {
      x += (targetX - x) * 0.2;
      y += (targetY - y) * 0.2;
      element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      frame = window.requestAnimationFrame(tick);
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", press);
    window.addEventListener("pointerup", release);
    document.documentElement.addEventListener("pointerleave", leave);
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", press);
      window.removeEventListener("pointerup", release);
      document.documentElement.removeEventListener("pointerleave", leave);
      window.cancelAnimationFrame(frame);
    };
  }, []);
  return <div ref={ref} className="cursor" aria-hidden="true"><i /></div>;
}

const BEATS = [
  {
    id: "mess",
    index: "01",
    title: "Bring the mess.",
    body: "Paste an assignment sheet, a syllabus, an email thread, a chaotic checklist. PlanPilot pulls the actual work out of the noise and keeps the source right beside it.",
  },
  {
    id: "sorted",
    index: "02",
    title: "Watch it get sorted.",
    body: "Every task lands with a duration, a deadline, and a place on your day. Nothing is guessed, and every block can tell you why it sits where it sits.",
  },
  {
    id: "uncertain",
    index: "03",
    title: "Uncertainty stays visible.",
    body: "A vague “soon” never becomes a fake deadline. Low-confidence dates glow until you confirm them, so the plan is only ever as sure as you are.",
  },
  {
    id: "week",
    index: "04",
    title: "Your week, stacked.",
    body: "Seven realistic days with buffer protected. Miss a session and only that session moves. The rest of your week stays exactly where you left it.",
  },
] as const;

export function LandingExperience() {
  const reduced = usePrefersReducedMotion();
  const coarse = useMediaQuery("(hover: none)");
  const small = useMediaQuery("(max-width: 760px)");
  const client = useIsClient();
  const webgl = useWebGLSupport();
  const progressRef = useRef(0);
  const [sceneReady, setSceneReady] = useState(false);
  const [minTimePassed, setMinTimePassed] = useState(false);
  const [hasDragged, setHasDragged] = useState(false);
  const handleFirstDrag = useCallback(() => setHasDragged(true), []);

  const showScene = client && webgl && !small;
  const loaded = minTimePassed && (sceneReady || !showScene);

  useEffect(() => {
    const timer = window.setTimeout(() => setMinTimePassed(true), 1500);
    return () => window.clearTimeout(timer);
  }, []);

  // Scroll progress feeds the 3D camera path and a CSS variable for parallax copy.
  useEffect(() => {
    const update = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const p = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      progressRef.current = p;
      document.documentElement.style.setProperty("--scroll-p", p.toFixed(4));
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  // Show a beat's copy only while that beat fills the screen, so text never
  // lingers under the top bar or overlaps the next beat's copy.
  useEffect(() => {
    const beats = Array.from(document.querySelectorAll<HTMLElement>(".beat"));
    let frame = 0;
    const check = () => {
      frame = 0;
      const vh = window.innerHeight;
      beats.forEach((beat) => {
        const rect = beat.getBoundingClientRect();
        beat.classList.toggle("is-visible", rect.top <= vh * 0.4 && rect.bottom >= vh * 0.92);
      });
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className={`world ${loaded ? "world-loaded" : ""}`}>
      <Loader visible={!loaded} />
      {!coarse && <GlowCursor />}
      <div className="world-stage" aria-hidden="true">
        {showScene ? (
          <Suspense fallback={null}>
            <PlanWorldScene
              progressRef={progressRef}
              reducedMotion={reduced}
              interactive={!coarse}
              onReady={() => setSceneReady(true)}
              onFirstDrag={handleFirstDrag}
            />
          </Suspense>
        ) : (
          <div className="world-static"><ClockFallback /></div>
        )}
        <div className="world-vignette" />
      </div>

      {showScene && !coarse && (
        <div className={`drag-hint ${hasDragged ? "is-done" : ""}`} aria-hidden="true">
          <span className="drag-hint-icon" />
          Drag the clock to look around · double-click to reset
        </div>
      )}

      <header className="world-nav">
        <BrandLockup />
        <nav aria-label="Landing navigation">
          <a href="#mess">How it works</a>
          <a href="#week">Why PlanPilot</a>
        </nav>
        <div>
          <Link href="/login" className="text-link">Sign in</Link>
          <Link href="/onboarding" className="button button-primary button-md">
            Try the demo <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </header>

      <main className="story">
        <section className="beat beat-hero" id="top">
          <div className="beat-sticky">
            <div className="beat-copy">
              <span className="pill"><Sparkles size={13} aria-hidden="true" /> Planning that explains itself</span>
              <h1>
                Turn messy<br />responsibilities<br />into a plan<br />you can <em>trust.</em>
              </h1>
              <p>Paste the chaos. PlanPilot finds the work, flags what is uncertain, and builds a realistic schedule around the time you actually have.</p>
              <div className="hero-actions">
                <Link href="/onboarding" className="button button-primary button-lg">
                  Build my plan <ArrowRight size={17} aria-hidden="true" />
                </Link>
                <Link href="/dashboard" className="button button-secondary button-lg">Explore the demo</Link>
              </div>
              <div className="trust-row">
                <span><Check size={14} aria-hidden="true" /> No invented deadlines</span>
                <span><Check size={14} aria-hidden="true" /> Nothing exported before approval</span>
                <span><Check size={14} aria-hidden="true" /> Replans preserve your week</span>
              </div>
            </div>
            <a className="scroll-hint" href="#mess">
              <span>Scroll to see how</span>
              <ArrowDown size={16} aria-hidden="true" />
            </a>
          </div>
        </section>

        {BEATS.map((beat, index) => (
          <section className={`beat beat-${index % 2 === 0 ? "left" : "right"}`} id={beat.id} key={beat.id}>
            <div className="beat-sticky">
              <div className="beat-copy">
                <span className="beat-index">{beat.index}</span>
                <h2>{beat.title}</h2>
                <p>{beat.body}</p>
                {beat.id === "week" && (
                  <div className="hero-actions">
                    <Link href="/onboarding" className="button button-primary button-lg">
                      Build my plan <ArrowRight size={17} aria-hidden="true" />
                    </Link>
                    <Link href="/dashboard" className="button button-secondary button-lg">Explore the demo</Link>
                  </div>
                )}
              </div>
            </div>
          </section>
        ))}
      </main>

      <footer className="world-footer">
        <BrandLockup />
        <p>Plan with reality, not wishful thinking.</p>
        <span>© 2026 PlanPilot</span>
      </footer>
    </div>
  );
}
