/**
 * The caller's Slack identity — where the private alerts go (lib/client-alerts/slack-dm.ts).
 *
 * GET                                   → { configured, identity } as stored, no call to Slack
 * POST { action: "check", email? }      → looks the address up in Slack again; `email` (null = the login address) replaces it first
 * POST { action: "test" }               → one private message to the caller, and to nobody else
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { SlackDmError, cleanEmail, dmConfigured, resolveSlackIdentity, sendSlackDm, slackIdentityOf } from "@/lib/client-alerts/slack-dm";

export const maxDuration = 60;

const TEST_TEXT = "Test ImpulseMotion : vos alertes arriveront ici, en message privé.";
const NOT_CONFIGURED = "Les messages privés Slack ne sont pas encore configurés (webhook n8n absent).";

const failure = (what: string, err: SlackDmError) =>
  NextResponse.json({ error: `${what} (${err.message}). Réessayez dans quelques minutes.` }, { status: 502 });

export async function GET() {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const user = await prisma.user.findUnique({
    where: { id: guard.session.userId },
    select: { email: true, slackEmail: true, slackUserId: true, slackCheckedAt: true },
  });
  if (!user) return NextResponse.json({ error: "Compte introuvable." }, { status: 404 });
  return NextResponse.json({ configured: dmConfigured(), identity: slackIdentityOf(user) });
}

export async function POST(req: NextRequest) {
  const guard = await requireStaff();
  if ("error" in guard) return guard.error;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = body && typeof body === "object" ? body.action : null;
  if (action !== "check" && action !== "test") return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
  if (!dmConfigured()) return NextResponse.json({ error: NOT_CONFIGURED }, { status: 503 });

  if (action === "check") {
    // Absent = keep the address; null or "" = back to the login address.
    const raw = body!.email;
    let email: string | null | undefined;
    if (raw !== undefined) {
      const given = raw === null ? "" : typeof raw === "string" ? raw.trim() : null;
      email = given ? cleanEmail(given) : null;
      if (given === null || (given && !email)) return NextResponse.json({ error: "Adresse e-mail invalide." }, { status: 400 });
    }
    try {
      const identity = await resolveSlackIdentity(guard.session.userId, { force: true, ...(email !== undefined ? { email } : {}) });
      return NextResponse.json({ identity });
    } catch (err) {
      if (err instanceof SlackDmError) return failure("Slack n'a pas pu être interrogé", err);
      throw err;
    }
  }

  // The recipient is the session's own identity: nothing in the request can name someone else.
  try {
    const identity = await resolveSlackIdentity(guard.session.userId);
    if (identity.status !== "found" || !identity.slackUserId) {
      const where = identity.email ? ` avec l'adresse ${identity.email}` : "";
      return NextResponse.json({ error: `Votre compte Slack n'a pas été trouvé${where}. Vérifiez l'adresse, puis relancez la recherche.`, identity }, { status: 409 });
    }
    await sendSlackDm(identity.slackUserId, TEST_TEXT);
    return NextResponse.json({ ok: true, identity });
  } catch (err) {
    if (err instanceof SlackDmError) return failure("Le message de test n'a pas pu être envoyé", err);
    throw err;
  }
}
