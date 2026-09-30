/**
 * The caller's Slack identity — where the private alerts go (lib/client-alerts/slack-dm.ts).
 *
 * GET                                   → { configured, identity } as stored, no call to Slack
 * POST { action: "check", email? }      → looks the address up in Slack again; `email` (null = the login address) replaces it first
 *                                         (409 when it is the login address of another user); the identity carries the member's name
 * POST { action: "test" }               → one private message to the caller, and to nobody else. While sending is
 *                                         switched off (CLIENT_ALERTS_SEND), only a real administrator may send it:
 *                                         "nothing goes to Slack yet" must be true for everyone else, and the
 *                                         administrator needs one real message to check the delivery before opening.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { ADDRESS_TAKEN, SlackAddressError, SlackDmError, cleanEmail, dmConfigured, resolveSlackIdentity, sendSlackDm, slackIdentityOf } from "@/lib/client-alerts/slack-dm";
import { sendingEnabled } from "@/lib/client-alerts/types";

export const maxDuration = 60;

const TEST_TEXT = "Test ImpulseMotion : vos alertes arriveront ici, en message privé.";
const NOT_CONFIGURED = "Les messages privés Slack ne sont pas encore configurés.";
const TEST_MODE = "Mode d'essai : rien n'est encore envoyé dans Slack. Le message de test sera disponible à la mise en service des alertes.";

/** The consultant reads the words of slack-dm.ts; the technical cause (Slack's code, HTTP status) goes to the logs. */
const failure = (what: string, err: SlackDmError) => {
  console.error("[client-alerts] slack", err.detail);
  return NextResponse.json({ error: `${what} : ${err.message}. Réessayez dans quelques minutes.` }, { status: 502 });
};

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
    // The address of another person of the application is never somebody's Slack address: refused before anything is asked to Slack.
    if (email) {
      const other = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" }, NOT: { id: guard.session.userId } }, select: { id: true } });
      if (other) return NextResponse.json({ error: ADDRESS_TAKEN }, { status: 409 });
    }
    try {
      // `identity.name`: the member Slack found, for the person to see it is the right one.
      const identity = await resolveSlackIdentity(guard.session.userId, { force: true, ...(email !== undefined ? { email } : {}) });
      return NextResponse.json({ identity });
    } catch (err) {
      if (err instanceof SlackAddressError) return NextResponse.json({ error: err.message }, { status: 409 });
      if (err instanceof SlackDmError) return failure("Slack n'a pas pu être interrogé", err);
      throw err;
    }
  }

  if (!sendingEnabled() && guard.session.baseRole !== "admin") return NextResponse.json({ error: TEST_MODE }, { status: 409 });

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
