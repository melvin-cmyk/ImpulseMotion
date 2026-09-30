"use client";

/**
 * What stands between an alert and a private message in Slack, shown only
 * when something does: the person is not found in Slack (they type the
 * address of their Slack account and check it), sending is switched off (test
 * mode), or the private messages are not plugged yet.
 *
 * The identity is looked up and stored by POST /api/me/slack; the test message
 * goes to the caller and to nobody else.
 */

import { useState } from "react";
import { CheckCircle2, FlaskConical, Loader2, MessageSquareWarning } from "lucide-react";
import type { SlackIdentity } from "@/lib/client-alerts/types";

export interface SlackState { configured: boolean; identity: SlackIdentity | null }

const inputCls = "min-w-0 flex-1 px-3 py-1.5 rounded-lg text-sm bg-gray-950 border border-gray-800 text-white placeholder:text-gray-600 focus:border-violet-500 focus:outline-none disabled:opacity-60";
const btnCls = "px-3 py-1.5 rounded-lg text-xs font-medium bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

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
  // Found during this visit: the banner stays, to offer the test message.
  const [justFound, setJustFound] = useState(false);

  const askIdentity = configured && !found;
  if (!askIdentity && !justFound && sending && configured) return null;

  async function check() {
    setBusy("check"); setError(null); setMessage(null);
    try {
      const { identity: next } = await call({ action: "check", email: email.trim() });
      if (next) {
        onIdentity(next);
        setJustFound(next.status === "found");
        if (next.status !== "found") setError(`Slack ne connaît personne avec l'adresse ${next.email ?? email.trim()}. Essayez l'adresse avec laquelle vous vous connectez à Slack.`);
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

  return (
    <div className="bg-gray-900 border border-amber-900/40 rounded-2xl divide-y divide-gray-800">
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
      {askIdentity && (
        <div className="px-4 py-3 space-y-2">
          <p className="flex items-start gap-2 text-sm text-amber-200">
            <MessageSquareWarning className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
            <span>
              {identity?.status === "unknown"
                ? <>Slack ne connaît personne avec l&apos;adresse {identity.email ?? "de votre compte"}. </>
                : <>Votre compte Slack n&apos;a pas encore été retrouvé. </>}
              Indiquez l&apos;adresse e-mail de votre compte Slack : c&apos;est là que vos alertes arrivent, en message privé.
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
          </form>
        </div>
      )}
      {justFound && found && (
        <div className="px-4 py-3 flex flex-wrap items-center gap-3 text-sm text-emerald-300">
          <span className="inline-flex items-center gap-2"><CheckCircle2 className="w-4 h-4" />Compte Slack trouvé{identity?.email ? ` (${identity.email})` : ""}.</span>
          <button type="button" className={btnCls} onClick={() => void test()} disabled={busy !== null}>
            {busy === "test" ? <span className="inline-flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Envoi…</span> : "M'envoyer un test"}
          </button>
        </div>
      )}
      {(error || message) && (
        <p role="status" className={`px-4 py-2 text-xs ${error ? "text-red-400" : "text-emerald-400"}`}>{error ?? message}</p>
      )}
    </div>
  );
}
