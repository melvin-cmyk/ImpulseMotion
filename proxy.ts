import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const { pathname } = req.nextUrl;

  // DEV-only auth bypass for headless browser testing.
  // Set DEV_AUTH_BYPASS=1 in the local environment before `next dev` to enable.
  if (process.env.DEV_AUTH_BYPASS === "1") {
    return NextResponse.next();
  }

  // Public paths — never redirect these
  const publicPaths = ["/login", "/api/auth", "/api/relay", "/_next", "/favicon"];
  if (publicPaths.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  if (!req.auth) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
});

export const config = {
  matcher: [
    /*
     * Protect all routes except:
     * - /login
     * - /share/* (public shareable reports)
     * - /api/auth/* (NextAuth routes)
     * - /_next/* (static files)
     * - /favicon.ico
     */
    "/((?!login|share|api/auth|_next/static|_next/image|favicon.ico|.*\\.txt).*)",
  ],
};
