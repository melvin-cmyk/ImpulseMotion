import { auth } from "@/auth";
import { NextResponse } from "next/server";

// Route surface reachable by the "client" role — the dashboard and the API it
// needs, nothing else. Everything outside redirects to /client (pages) or 403s (APIs).
const CLIENT_ALLOWED_PREFIXES = [
  "/d",
  "/client",
  "/api/dashboards",
  "/api/client",
  "/api/me/accounts",
  "/api/meta/accounts",
  "/api/deck/proxy-image",
  "/api/auth",
];

// Admin-only surface (user & ACL management). Consultants get the rest of /admin.
const ADMIN_ONLY_PREFIXES = ["/admin/users", "/api/admin/users"];

function isAdminOnly(pathname: string): boolean {
  // /admin index page is the user-management screen
  if (pathname === "/admin") return true;
  return ADMIN_ONLY_PREFIXES.some((p) => pathname.startsWith(p));
}

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  const publicPaths = ["/login", "/api/auth", "/api/cron", "/_next", "/favicon"];
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
    const allowed = isAdminOnly(pathname) ? session.role === "admin" : isStaff;
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
    "/((?!login|share|api/auth|_next/static|_next/image|favicon.ico|.*\\.txt).*)",
  ],
};
