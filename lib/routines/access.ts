/**
 * Routines — the ONE guard of the routes of the feature.
 *
 * Every route under app/api/routines starts with:
 *
 *   const guard = await requireRoutinesAccess();
 *   if ("error" in guard) return guard.error;
 *
 * and none calls requireStaff() itself: a test walks the folder and fails on
 * a route file that does not (lib/__tests__/routines-access.test.ts).
 *
 * The rule is in lib/routines/access-rule.ts. 401 without a session, 403
 * without the access.
 */

import { requireRealAdmin, requireStaff } from "@/lib/auth-helpers";
import { routinesAccessMode } from "@/lib/routines/access-rule";

export async function requireRoutinesAccess() {
  return routinesAccessMode() === "staff" ? requireStaff() : requireRealAdmin();
}
