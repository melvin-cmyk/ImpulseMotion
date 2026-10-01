/**
 * Binding a TikTok advertiser to a dashboard — one path for every route that
 * does it (sources panel, dashboard creation, dashboard re-bind).
 *
 * 1. the id is normalised (digits only);
 * 2. it must be in the staff member's scope (bindingOutOfScope): binding
 *    grants access to the account, exactly like a Meta or Google binding;
 * 3. TikTok is asked who the advertiser is (one token reads every account of
 *    the agency: what is stored is TikTok's answer, never a name sent by the
 *    browser);
 * 4. stored as a DashboardSource "tiktok", and the dashboard's owner and
 *    members get the matching ACL row (the widgets' re-check reads it).
 */

import { prisma } from "@/lib/prisma";
import { bindingOutOfScope, type AccountScope } from "@/lib/scope";
import { attachTikTokAdvertiser, checkAdvertiser, normalizeAdvertiserId, type TikTokAdvertiser } from "@/lib/tiktok-accounts";
import { grantDashboardAccess } from "@/lib/dashboard-widgets";

export const TIKTOK_ID_INVALID = "Identifiant du compte TikTok Ads invalide : il ne contient que des chiffres (TikTok Ads Manager, en haut à droite sous le nom du compte).";

export type TikTokBindingCheck =
  | { ok: true; advertiser: TikTokAdvertiser }
  | { ok: false; status: 400 | 403; error: string };

/** Steps 1-3: may this staff member bind this advertiser, and who is it? Nothing is stored. */
export async function checkTikTokBinding(raw: unknown, scope: AccountScope): Promise<TikTokBindingCheck> {
  const id = normalizeAdvertiserId(raw);
  if (!id) return { ok: false, status: 400, error: TIKTOK_ID_INVALID };
  const offending = bindingOutOfScope(scope, { tiktokAdvertiserIds: [id] });
  if (offending) return { ok: false, status: 403, error: `compte hors périmètre : ${offending}` };
  const checked = await checkAdvertiser(id);
  if (!checked.ok) return { ok: false, status: 400, error: checked.error };
  return { ok: true, advertiser: checked.advertiser };
}

/** Step 4: stores a checked advertiser on the dashboard and opens it to the dashboard's people. */
export async function bindTikTokAdvertiser(dashboardId: string, advertiser: TikTokAdvertiser): Promise<{ id: string }> {
  const stored = await attachTikTokAdvertiser(dashboardId, advertiser);
  const dashboard = await prisma.dashboard.findUnique({
    where: { id: dashboardId },
    select: { name: true, userId: true, members: { select: { userId: true } } },
  });
  if (dashboard) {
    const access = { name: dashboard.name, metaAccountId: null, googleCustomerId: null, tiktokAdvertiserIds: [advertiser.id] };
    for (const uid of new Set([dashboard.userId, ...dashboard.members.map((m) => m.userId)])) {
      await grantDashboardAccess(uid, access);
    }
  }
  return stored;
}
