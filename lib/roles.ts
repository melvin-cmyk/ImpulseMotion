/**
 * Roles as the application applies them.
 *
 * Consultants and admins work the same way: every ad account, every client,
 * every AI tool, dashboards and reports on any client. Nothing is assigned
 * to a consultant — it proved too hard to follow.
 *
 * What sets an admin apart is the CLIENT side, and only that:
 *   - the people: creating a login, changing a role, resetting a password;
 *   - what a client may see: the clients attached to a dashboard;
 *   - the private AI assistant of a client: its set-up and who may use it.
 *
 * Rather than touching every check, the session carries the role that is
 * APPLIED (`role`, "admin" for a consultant) next to the one the person
 * really has (`baseRole`). The client side asks for `baseRole === "admin"`.
 *
 * To give consultants a narrower access one day: set CONSULTANT_FULL_ACCESS
 * to false. Nothing else has to change.
 */
export const CONSULTANT_FULL_ACCESS = true;

/** Role applied to the checks of the application. */
export function effectiveRole(role: string | null | undefined): string {
  if (role === "consultant" && CONSULTANT_FULL_ACCESS) return "admin";
  return role ?? "client";
}

/** Pages and APIs that stay with the people who really are admins. */
export const REAL_ADMIN_PREFIXES = ["/admin/users", "/api/admin/users", "/admin/bots", "/api/admin/bots"];

export function isRealAdminPath(pathname: string): boolean {
  // The /admin index is the user-management screen.
  return pathname === "/admin" || REAL_ADMIN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
