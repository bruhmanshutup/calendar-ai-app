// Optional site-wide passcode. When APP_PASSCODE is unset (local dev) the
// site is open; when set (hosted), every page and API needs the unlock cookie.

export const PASSCODE_COOKIE = "planpilot_unlock";
export const PASSCODE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export function configuredPasscode(): string | undefined {
  return process.env.APP_PASSCODE?.trim() || undefined;
}

// The cookie holds a hash of the passcode, never the passcode itself.
export async function passcodeToken(passcode: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`planpilot-unlock:${passcode}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function sameText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

// Only allow redirects back to a path on this site.
export function safeNextPath(value: unknown): string {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\")
    ? value
    : "/";
}
