/**
 * Roles as the application applies them.
 *
 * For now a consultant may do everything an admin does: the agency has not
 * decided yet what sets them apart. Rather than touching every check, the
 * session carries the role that is APPLIED (`role`) next to the one the
 * person really has (`baseRole`).
 *
 * One thing stays with the real admins: managing people (accounts, roles,
 * passwords) and the Claude subscriptions of the AI — whoever can change
 * roles can lock everybody else out.
 *
 * To give consultants their own, narrower access again: set
 * CONSULTANT_FULL_ACCESS to false. Nothing else has to change.
 */
export const CONSULTANT_FULL_ACCESS = true;

/** Role applied to the checks of the application. */
export function effectiveRole(role: string | null | undefined): string {
  if (role === "consultant" && CONSULTANT_FULL_ACCESS) return "admin";
  return role ?? "client";
}

/** Pages and APIs that stay with the people who really are admins. */
export const REAL_ADMIN_PREFIXES = ["/admin/users", "/api/admin/users"];

export function isRealAdminPath(pathname: string): boolean {
  // The /admin index is the user-management screen.
  return pathname === "/admin" || REAL_ADMIN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
