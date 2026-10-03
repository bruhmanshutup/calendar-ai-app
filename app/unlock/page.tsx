import type { Metadata } from "next";
import { safeNextPath } from "@/lib/security/passcode";

export const metadata: Metadata = { title: "Unlock" };

export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 16,
        background: "var(--bg, #0b0b12)",
        color: "var(--ink, #f4f4f8)",
      }}
    >
      <form
        method="post"
        action="/api/unlock"
        style={{
          width: "100%",
          maxWidth: 360,
          display: "grid",
          gap: 14,
          padding: 28,
          borderRadius: 18,
          border: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
          background: "color-mix(in srgb, currentColor 4%, transparent)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>PlanPilot is locked</h1>
        <p style={{ margin: 0, opacity: 0.7, fontSize: 14 }}>
          Enter the passcode to open your planner.
        </p>
        <input type="hidden" name="next" value={safeNextPath(next)} />
        <input
          type="password"
          name="passcode"
          autoFocus
          required
          autoComplete="current-password"
          aria-label="Passcode"
          placeholder="Passcode"
          style={{
            padding: "12px 14px",
            borderRadius: 12,
            border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
            background: "transparent",
            color: "inherit",
            fontSize: 16,
          }}
        />
        {error ? (
          <p role="alert" style={{ margin: 0, color: "#f5a524", fontSize: 14 }}>
            That passcode didn&apos;t match. Try again.
          </p>
        ) : null}
        <button
          type="submit"
          style={{
            padding: "12px 14px",
            borderRadius: 999,
            border: 0,
            background: "#7c6cf2",
            color: "#fff",
            fontSize: 15,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Unlock
        </button>
      </form>
    </main>
  );
}
