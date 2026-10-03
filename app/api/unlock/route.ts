import { NextResponse } from "next/server";
import {
  PASSCODE_COOKIE,
  PASSCODE_COOKIE_MAX_AGE,
  configuredPasscode,
  passcodeToken,
  safeNextPath,
  sameText,
} from "@/lib/security/passcode";

export async function POST(request: Request) {
  const form = await request.formData();
  const next = safeNextPath(form.get("next"));
  const attempt = String(form.get("passcode") ?? "").trim();
  const passcode = configuredPasscode();

  if (!passcode) {
    return NextResponse.redirect(new URL(next, request.url), 303);
  }

  const [expected, received] = await Promise.all([
    passcodeToken(passcode),
    passcodeToken(attempt),
  ]);
  if (!sameText(expected, received)) {
    const retry = new URL("/unlock", request.url);
    retry.searchParams.set("next", next);
    retry.searchParams.set("error", "1");
    return NextResponse.redirect(retry, 303);
  }

  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(PASSCODE_COOKIE, expected, {
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: PASSCODE_COOKIE_MAX_AGE,
  });
  return response;
}
