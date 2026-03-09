export { auth as middleware } from "@/auth";

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
    "/((?!login|share|api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
