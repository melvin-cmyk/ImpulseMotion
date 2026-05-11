import { auth } from "@/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const { pathname } = req.nextUrl;
  const session = req.auth;

  if (process.env.DEV_AUTH_BYPASS === "1") {
    return NextResponse.next();
  }

  const publicPaths = ["/login", "/api/auth", "/api/relay", "/api/cron", "/_next", "/favicon"];
  const isPublic = publicPaths.some((p) => pathname.startsWith(p));

  const isAdminPath = pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
  if (isAdminPath) {
    if (!session?.userId) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      }
      return NextResponse.redirect(new URL("/login", req.url));
    }
    if (session.role !== "admin") {
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
    return NextResponse.redirect(new URL("/login", req.url));
  }
});

export const config = {
  matcher: [
    "/((?!login|share|api/auth|_next/static|_next/image|favicon.ico|.*\\.txt).*)",
  ],
};
