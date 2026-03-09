import { auth } from "@/auth";
import { NextResponse } from "next/server";

export const proxy = auth((req) => {
  const { pathname } = req.nextUrl;

  // Public paths that don't require authentication
  const publicPaths = ["/login", "/share", "/api/auth"];
  const isPublic = publicPaths.some((p) => pathname.startsWith(p));

  if (!req.auth && !isPublic) {
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
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
