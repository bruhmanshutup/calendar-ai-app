/**
 * "This week" wave card for the Overview (copy only).
 * Style source: MotionSites "Forecast Center" sample prompt — a smooth white
 * wave chart over frosted glass, day labels underneath with the current day
 * bolder, and the line drawing itself in on load. Big numbers follow the
 * MotionSites "F1 Racing Hub" sample (large stats, one in the accent color).
 */

export type WaveDay = { label: string; minutes: number; isToday: boolean };

const WIDTH = 700;
const HEIGHT = 150;
const TOP = 26;
const BOTTOM = 132;

function pointsFor(days: WaveDay[]) {
  const max = Math.max(60, ...days.map((day) => day.minutes));
  return days.map((day, index) => ({
    // Centered over each day label, so the dots sit right above their day.
    x: ((index + 0.5) / days.length) * WIDTH,
    y: BOTTOM - (day.minutes / max) * (BOTTOM - TOP),
  }));
}

/** Smooth curve through every point (Catmull-Rom converted to cubic Béziers). */
function smoothPath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return "";
  const round = (value: number) => Math.round(value * 10) / 10;
  let path = `M${round(points[0].x)} ${round(points[0].y)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const before = points[index - 1] ?? points[index];
    const from = points[index];
    const to = points[index + 1];
    const after = points[index + 2] ?? to;
    const c1x = from.x + (to.x - before.x) / 6;
    const c1y = from.y + (to.y - before.y) / 6;
    const c2x = to.x - (after.x - from.x) / 6;
    const c2y = to.y - (after.y - from.y) / 6;
    path += ` C${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(to.x)} ${round(to.y)}`;
  }
  return path;
}

function formatMinutes(minutes: number): string {
  if (minutes === 0) return "Free";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest}m` : rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function WeekWave({
  days,
  sessionCount,
  todayCount,
}: {
  days: WaveDay[];
  sessionCount: number;
  todayCount: number;
}) {
  const points = pointsFor(days);
  // Run the line edge to edge by extending the first and last day flat.
  const line = points.length ? smoothPath([{ x: 0, y: points[0].y }, ...points, { x: WIDTH, y: points[points.length - 1].y }]) : "";
  const area = line ? `${line} L${WIDTH} ${HEIGHT} L0 ${HEIGHT} Z` : "";
  const totalMinutes = days.reduce((sum, day) => sum + day.minutes, 0);
  const busiest = days.reduce<WaveDay | undefined>((best, day) => (day.minutes > (best?.minutes ?? 0) ? day : best), undefined);
  return (
    <section className="wave-card" aria-label="This week at a glance">
      <div className="wave-card-head">
        <span className="glass-chip">This week</span>
        <dl className="wave-stats">
          <div>
            <dt>Planned</dt>
            <dd className="is-accent">{formatMinutes(totalMinutes)}</dd>
          </div>
          <div>
            <dt>Sessions</dt>
            <dd>{sessionCount}</dd>
          </div>
          <div>
            <dt>Today</dt>
            <dd>{todayCount}</dd>
          </div>
          <div>
            <dt>Busiest</dt>
            <dd>{busiest ? busiest.label : "—"}</dd>
          </div>
        </dl>
      </div>
      <div className="wave-chart">
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="wave-stroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.35" />
              <stop offset="50%" stopColor="currentColor" stopOpacity="1" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.35" />
            </linearGradient>
            <linearGradient id="wave-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path className="wave-area" d={area} fill="url(#wave-fill)" />
          <path className="wave-glow" d={line} fill="none" stroke="currentColor" strokeOpacity="0.16" strokeWidth="6" vectorEffect="non-scaling-stroke" pathLength={1} />
          <path className="wave-line" d={line} fill="none" stroke="url(#wave-stroke)" strokeWidth="2.4" strokeLinecap="round" vectorEffect="non-scaling-stroke" pathLength={1} />
        </svg>
        {points.map((point, index) => (
          <span
            key={days[index].label}
            className={`wave-dot ${days[index].isToday ? "is-today" : ""}`}
            style={{ left: `${(point.x / WIDTH) * 100}%`, top: `${(point.y / HEIGHT) * 100}%` }}
            aria-hidden="true"
          />
        ))}
      </div>
      <ol className="wave-days">
        {days.map((day) => (
          <li key={day.label} className={day.isToday ? "is-today" : ""}>
            <span>{day.label}</span>
            <small>{formatMinutes(day.minutes)}</small>
          </li>
        ))}
      </ol>
    </section>
  );
}
