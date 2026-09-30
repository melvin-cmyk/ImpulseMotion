"use client";

/**
 * Where the alerts go in Slack, and what stands between an alert and a private
 * message: the person is not found in Slack (they type the address of their
 * Slack account and check it), sending is switched off (test mode), or the
 * private messages are not plugged yet.
 *
 * Once the person is found the banner does not disappear: one discreet line
 * stays — « Slack : <adresse> · Modifier · M'envoyer un test » — so that the
 * address can be read, changed and tried at any time. In test mode the test
 * message is offered to a real administrator only (same rule as the route).
 *
 * The identity is looked up and stored by POST /api/me/slack; the test message
 * goes to the caller and to nobody else.
 */

import { useState } from "react";
import { useSession } from "next-auth/react";
import { CheckCircle2, FlaskConical, Loader2, MessageSquareWarning } from "lucide-react";
import type { SlackIdentity } from "@/lib/client-alerts/types";
import { slackFoundLine } from "@/components/client-alerts/alert-model";

export interface SlackState { configured: boolean; identity: SlackIdentity | null }

const inputCls = "min-w-0 flex-1 px-3 py-1.5 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white placeholder:text-gray-600 focus:border-violet-500 focus:outline-none disabled:opacity-60";
const btnCls = "px-3 py-1.5 rounded-lg text-xs font-medium bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const linkCls = "underline text-gray-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed";

async function call(body: Record<string, unknown>): Promise<{ identity?: SlackIdentity }> {
  const res = await fetch("/api/me/slack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Erreur ${res.status}`);
  return json;
}

export function SlackBanner({ slack, sending, onIdentity }: {
  slack: SlackState;
  sending: boolean;
  /** The identity as Slack just answered it: the page keeps it for the rest of the visit. */
  onIdentity: (identity: SlackIdentity) => void;
}) {
  const { configured, identity } = slack;
  const found = identity?.status === "found";
  const [email, setEmail] = useState(identity?.email ?? "");
  const [busy, setBusy] = useState<"check" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // The form of the address: always there while the person is not found, on request afterwards.
  const [editing, setEditing] = useState(false);

  const askIdentity = configured && (!found || editing);
  const realAdmin = useSession().data?.baseRole === "admin";
  const canTest = sending || realAdmin;

  async function check() {
    setBusy("check"); setError(null); setMessage(null);
    try {
      const { identity: next } = await call({ action: "check", email: email.trim() });
      if (next) {
        onIdentity(next);
        if (next.status === "found") {
          setEditing(false);
          setMessage(slackFoundLine(next));
        } else {
          setError(`Slack ne connaît personne avec l'adresse ${next.email ?? email.trim()}. Essayez l'adresse avec laquelle vous vous connectez à Slack.`);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "La vérification a échoué.");
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test"); setError(null); setMessage(null);
    try {
      await call({ action: "test" });
      setMessage("Message de test envoyé : regardez vos messages privés dans Slack.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Le message de test n'a pas pu être envoyé.");
    } finally {
      setBusy(null);
    }
  }

  const quiet = sending && configured && found && !editing;

  return (
    <div className={`bg-gray-900 border rounded-2xl divide-y divide-gray-800 ${quiet ? "border-gray-800" : "border-amber-900/40"}`}>
      {!sending && (
        <p className="px-4 py-3 flex items-start gap-2 text-sm text-amber-200">
          <FlaskConical className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
          <span>Mode d&apos;essai : les alertes sont enregistrées ici mais rien n&apos;est encore envoyé dans Slack.</span>
        </p>
      )}
      {sending && !configured && (
        <p className="px-4 py-3 flex items-start gap-2 text-sm text-amber-200">
          <MessageSquareWarning className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
          <span>Les messages privés Slack ne sont pas encore branchés : vos alertes sont enregistrées ici, et leurs déclenchements se lisent dans cette page.</span>
        </p>
      )}
      {configured && found && !editing && (
        <p className="px-4 py-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-400">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-500" />
          <span>Slack : <span className="text-gray-200 break-all">{identity?.email ?? "adresse de votre compte"}</span></span>
          <span aria-hidden>·</span>
          <button type="button" className={linkCls} disabled={busy !== null} onClick={() => { setEditing(true); setError(null); setMessage(null); }}>Modifier</button>
          {canTest && (
            <>
              <span aria-hidden>·</span>
              <button type="button" className={linkCls} disabled={busy !== null} onClick={() => void test()}>
                {busy === "test" ? <span className="inline-flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />Envoi…</span> : "M'envoyer un test"}
              </button>
            </>
          )}
        </p>
      )}
      {askIdentity && (
        <div className="px-4 py-3 space-y-2">
          <p className="flex items-start gap-2 text-sm text-amber-200">
            <MessageSquareWarning className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
            <span>
              {found
                ? <>Indiquez l&apos;adresse e-mail de votre compte Slack : </>
                : identity?.status === "unknown"
                  ? <>Slack ne connaît personne avec l&apos;adresse {identity.email ?? "de votre compte"}. Indiquez l&apos;adresse e-mail de votre compte Slack : </>
                  : <>Votre compte Slack n&apos;a pas encore été retrouvé. Indiquez l&apos;adresse e-mail de votre compte Slack : </>}
              c&apos;est là que vos alertes arrivent, en message privé.
            </span>
          </p>
          <form onSubmit={(e) => { e.preventDefault(); void check(); }} className="flex flex-wrap items-center gap-2 sm:pl-6">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="prenom@impulse-analytics.com"
              aria-label="Adresse e-mail de votre compte Slack"
              disabled={busy !== null}
              className={`${inputCls} sm:max-w-xs`}
            />
            <button type="submit" className={btnCls} disabled={busy !== null || !email.trim()}>
              {busy === "check" ? <span className="inline-flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Recherche…</span> : "Vérifier"}
            </button>
            {found && <button type="button" className={linkCls + " text-xs"} disabled={busy !== null} onClick={() => { setEditing(false); setEmail(identity?.email ?? ""); setError(null); }}>Annuler</button>}
          </form>
        </div>
      )}
      {(error || message) && (
        <p role="status" className={`px-4 py-2 text-xs ${error ? "text-red-400" : "text-emerald-400"}`}>{error ?? message}</p>
      )}
    </div>
  );
}
