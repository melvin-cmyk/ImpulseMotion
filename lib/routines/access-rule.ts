/**
 * Routines — who may enter the space: the rule, and nothing else.
 *
 * ROUTINES_ACCESS, read on the server:
 *   absent, "admin", or ANY other value → real administrators only
 *                                         (baseRole, lib/roles.ts): closed by default
 *   "staff"                             → all the staff, admins and consultants
 *
 * A client never enters, whatever the setting.
 *
 * Pure: no database, no session read here. It is used by the guard of the
 * routes (lib/routines/access.ts), by the proxy and the layout of the pages,
 * and by the session callback (auth.ts), which hands the answer down to the
 * browser as `session.routinesAccess`: the menu never reads the environment.
 *
 * The setting opens and closes the SPACE (pages and API). It does not stop a
 * routine that is active: the cron runs it whatever the setting. To stop
 * everything, the routines are paused.
 */

export const ROUTINES_ACCESS_ENV = "ROUTINES_ACCESS";
export type RoutinesAccessMode = "admin" | "staff";

export function routinesAccessMode(env: Record<string, string | undefined> = process.env): RoutinesAccessMode {
  return env[ROUTINES_ACCESS_ENV] === "staff" ? "staff" : "admin";
}

type SessionLike = { userId?: string | null; role?: string | null; baseRole?: string | null } | null | undefined;

/** True when the person of the session may enter the space of the routines. */
export function hasRoutinesAccess(session: SessionLike, env: Record<string, string | undefined> = process.env): boolean {
  if (!session?.userId) return false;
  if (session.baseRole === "admin") return true;
  if (routinesAccessMode(env) !== "staff") return false;
  return session.role === "admin" || session.role === "consultant";
}

export const isRoutinesPath = (pathname: string): boolean =>
  pathname === "/routines" || pathname.startsWith("/routines/") || pathname === "/api/routines" || pathname.startsWith("/api/routines/");
