import { NextResponse, type NextRequest } from "next/server";
import {
  PASSCODE_COOKIE,
  configuredPasscode,
  passcodeToken,
  sameText,
} from "@/lib/security/passcode";

export async function proxy(request: NextRequest) {
  const passcode = configuredPasscode();
  if (!passcode) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  if (pathname === "/unlock" || pathname === "/api/unlock") {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(PASSCODE_COOKIE)?.value ?? "";
  if (sameText(cookie, await passcodeToken(passcode))) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: "LOCKED", message: "Enter the passcode first." } },
      { status: 401 },
    );
  }

  const unlock = request.nextUrl.clone();
  unlock.pathname = "/unlock";
  unlock.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(unlock);
}

export const config = {
  // Skip build assets and any file with an extension (models, images, fonts).
  matcher: ["/((?!_next/static|_next/image|.*\\..*).*)"],
};
