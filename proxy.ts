import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { isRealAdminPath } from "@/lib/roles";
import { hasRoutinesAccess, isRoutinesPath } from "@/lib/routines/access-rule";

// Route surface reachable by the "client" role — the dashboard and the API it
// needs, nothing else. Everything outside redirects to /client (pages) or 403s (APIs).
const CLIENT_ALLOWED_PREFIXES = [
  "/d",
  "/client",
  "/api/dashboards",
  "/api/me/accounts",
  "/api/meta/accounts",
  "/api/media/proxy-image",
  "/api/auth",
  "/bot",
  "/api/bot",
  // Own-account management: a client must be able to change their password.
  "/settings",
  "/api/me/password",
];


export default auth((req) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  // /api/cron and /api/ingest authenticate themselves (CRON_SECRET / bearer token).
  // /api/tiktok-verify must answer the TikTok crawler, which has no session.
  const publicPaths = ["/login", "/api/auth", "/api/cron", "/api/ingest", "/api/tiktok-verify", "/_next", "/favicon"];
  const isPublic = publicPaths.some((p) => pathname.startsWith(p));

  const isAdminPath = pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
  if (isAdminPath) {
    if (!session?.userId) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      return NextResponse.redirect(new URL("/login", req.url));
    }
    const isStaff = session.role === "admin" || session.role === "consultant";
    // People management stays with the real admins; the rest follows the applied role.
    const allowed = isRealAdminPath(pathname) ? session.baseRole === "admin" : isStaff;
    if (!allowed) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  if (isPublic) {
    return NextResponse.next();
  }

  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }

  // The space of the routines is closed to who has not the access (ROUTINES_ACCESS): same answer as for a
  // client elsewhere, a redirection for a page and 403 for the API. The routes check again by themselves.
  if (session.role !== "client" && isRoutinesPath(pathname) && !hasRoutinesAccess(session)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/", req.url));
  }

  // Clients only ever see their dashboard.
  if (session.role === "client") {
    const allowed = CLIENT_ALLOWED_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(p + "/"),
    );
    if (!allowed) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
      return NextResponse.redirect(new URL("/d", req.url));
    }
  }
});

export const config = {
  matcher: [
    // The exclusion names the TikTok verification file explicitly: a blanket
    // `.*\.txt` would let ANY future route ending in .txt — /api/ ones
    // included — skip the middleware entirely.
    "/((?!login|share|api/auth|_next/static|_next/image|favicon.ico|tiktokvWEKPzvuaeiKervgnnetgZzrGjHnHDad\\.txt).*)",
  ],
};
