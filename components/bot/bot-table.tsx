"use client";

/**
 * A table in an assistant reply, with « Ouvrir dans Google Sheets »: the cells
 * as shown go to POST /api/bot/[botId]/sheet, which creates the sheet in the
 * client's Drive folder and shares it with them; the sheet opens in a new tab.
 */

import { useRef, useState } from "react";
import { ExternalLink, Loader2, Sheet } from "lucide-react";

export function BotTable({ botId, title, children }: { botId: string; title: string; children?: React.ReactNode }) {
  const ref = useRef<HTMLTableElement>(null);
  const [state, setState] = useState<{ busy: boolean; url?: string; error?: string; notified?: boolean }>({ busy: false });

  async function exportSheet() {
    const el = ref.current;
    if (!el) return;
    const text = (c: Element) => (c.textContent ?? "").trim();
    const head = el.querySelector("thead tr");
    const bodyRows = Array.from(el.querySelectorAll("tbody tr"));
    const columns = head ? Array.from(head.children).map(text) : Array.from(bodyRows.shift()?.children ?? []).map(text);
    const rows = bodyRows.map((r) => Array.from(r.children).map(text));
    // Opened at once (inside the click) so the browser does not block it, then pointed at the sheet.
    const win = window.open("", "_blank");
    setState({ busy: true });
    try {
      const res = await fetch(`/api/bot/${botId}/sheet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, columns, rows }),
      });
      const j = (await res.json().catch(() => ({}))) as { url?: string; notified?: boolean; error?: string };
      if (!res.ok || !j.url) throw new Error(j.error || `Erreur ${res.status}`);
      if (win) win.location.href = j.url;
      setState({ busy: false, url: j.url, notified: j.notified });
    } catch (e) {
      win?.close();
      setState({ busy: false, error: e instanceof Error ? e.message : "Export impossible" });
    }
  }

  return (
    <div className="not-prose my-4">
      <div className="overflow-x-auto">
        <table ref={ref} className="w-full text-xs tabular-nums border-collapse [&_th]:text-left [&_th]:font-medium [&_th]:text-ui-fg2 [&_th]:px-3 [&_th]:py-2 [&_th]:border-b [&_th]:border-ui-line-strong [&_td]:px-3 [&_td]:py-1.5 [&_td]:border-b [&_td]:border-ui-line [&_td]:text-ui-fg">
          {children}
        </table>
      </div>
      <div className="mt-2 flex items-center gap-3 text-xs">
        <button
          type="button"
          onClick={() => void exportSheet()}
          disabled={state.busy}
          className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-ui-fg2 hover:text-ui-fg hover:bg-ui-raised disabled:opacity-50 transition-colors duration-150"
        >
          {state.busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sheet className="w-3.5 h-3.5" strokeWidth={1.5} />}
          {state.busy ? "Création de la feuille" : "Ouvrir dans Google Sheets"}
        </button>
        {state.url && (
          <a href={state.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ui-accent-ink hover:underline">
            Feuille créée <ExternalLink className="w-3 h-3" strokeWidth={1.5} />
          </a>
        )}
        {state.notified && <span className="text-ui-muted">Un e-mail d&apos;accès vous a été envoyé par Google</span>}
        {state.error && <span className="text-ui-neg">{state.error}</span>}
      </div>
    </div>
  );
}
