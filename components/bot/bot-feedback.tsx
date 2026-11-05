"use client";

/**
 * « Votre avis » box of a client bot: thumbs up / down and a few words, sent to
 * POST /api/bot/[botId]/feedback and read by the admins (/admin/bots/[id]).
 * `compact` = the variant shown above the composer on small screens.
 */

import { useState } from "react";
import { Check, Loader2, ThumbsDown, ThumbsUp } from "lucide-react";

export function BotFeedbackBox({ botId, conversationId, onClose }: { botId: string; conversationId: string | null; onClose?: () => void }) {
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!message.trim() && !rating) return;
    setState("sending");
    setError(null);
    try {
      const res = await fetch(`/api/bot/${botId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, rating, conversationId }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error || `Erreur ${res.status}`);
      setState("sent");
      setMessage("");
      setRating(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Envoi impossible");
      setState("idle");
    }
  }

  if (state === "sent") {
    return (
      <div className="flex items-start gap-2 text-xs text-ui-fg2" role="status">
        <Check className="w-4 h-4 text-ui-pos shrink-0" strokeWidth={1.5} />
        <span className="flex-1">Merci, votre retour est transmis à votre équipe Impulse Analytics</span>
        <button type="button" onClick={() => { setState("idle"); onClose?.(); }} className="text-ui-muted hover:text-ui-fg">Fermer</button>
      </div>
    );
  }

  const thumb = (value: "up" | "down", Icon: typeof ThumbsUp, label: string) => (
    <button
      type="button"
      onClick={() => setRating(rating === value ? null : value)}
      aria-pressed={rating === value}
      aria-label={label}
      title={label}
      className={`h-8 w-8 flex items-center justify-center rounded-lg transition-colors duration-150 ${rating === value ? "bg-ui-raised text-ui-fg shadow-[inset_0_0_0_1px_var(--ui-line-strong)]" : "text-ui-muted hover:text-ui-fg hover:bg-ui-raised"}`}
    >
      <Icon className="w-4 h-4" strokeWidth={1.5} />
    </button>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-ui-fg">Votre avis sur l&apos;assistant</span>
        <div className="flex items-center gap-1">
          {thumb("up", ThumbsUp, "Utile")}
          {thumb("down", ThumbsDown, "Pas utile")}
        </div>
      </div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        maxLength={2000}
        placeholder="Une réponse fausse, une donnée qui manque, une idée"
        aria-label="Votre retour"
        className="w-full resize-none rounded-lg border border-ui-line-strong bg-ui-card px-3 py-2 text-sm text-ui-fg placeholder:text-ui-muted focus:outline-none focus:border-ui-accent transition-colors duration-150"
      />
      {error && <p className="text-xs text-ui-neg">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-ui-muted">Lu par votre équipe Impulse Analytics</span>
        <button
          type="button"
          onClick={() => void send()}
          disabled={state === "sending" || (!message.trim() && !rating)}
          className="h-8 px-3 inline-flex items-center gap-1.5 rounded-lg text-xs font-medium bg-ui-inverse text-ui-on-inverse hover:opacity-90 disabled:opacity-40 transition-opacity duration-150"
        >
          {state === "sending" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Envoyer
        </button>
      </div>
    </div>
  );
}
