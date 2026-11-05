"use client";

/**
 * Fichiers de données du bot client : import depuis le chat (CSV / Excel lus
 * dans le navigateur, envoyés par lots à /api/bot/[botId]/datasets) et liste
 * des fichiers que l'assistant peut lire. Affiché seulement si la source
 * « Fichiers de données » est ouverte sur le bot.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FileSpreadsheet, Loader2, Paperclip, Trash2 } from "lucide-react";
import { MAX_UPLOAD_BYTES, UPLOAD_ACCEPT, readDataFile, splitParts } from "@/lib/dataset-file-reader";

export type BotFile = { datasetKey: string; name: string; rowCount: number; columns: string[]; loadedAt: string | null; uploaded: boolean };
export type UploadState = { fileName: string; done: number; total: number } | null;
export type UploadNotice = { tone: "ok" | "error"; text: string; fileName?: string } | null;

function loadId(): string {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return `chat-${Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function useBotFiles(botId: string, enabled: boolean) {
  const base = `/api/bot/${botId}/datasets`;
  const [files, setFiles] = useState<BotFile[]>([]);
  const [upload, setUpload] = useState<UploadState>(null);
  const [notice, setNotice] = useState<UploadNotice>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const r = await fetch(base, { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { datasets: BotFile[] };
      setFiles(j.datasets ?? []);
    } catch { /* best effort */ }
  }, [base, enabled]);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch(base, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ datasets: BotFile[] }>) : null))
      .then((j) => { if (alive && j) setFiles(j.datasets ?? []); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [base, enabled]);

  /** Reads the file and sends it; resolves with the dataset name when it is visible to the bot. */
  const importFile = useCallback(async (file: File): Promise<string | null> => {
    setNotice(null);
    if (file.size > MAX_UPLOAD_BYTES) { setNotice({ tone: "error", text: "Fichier trop lourd (20 Mo au maximum)." }); return null; }
    setUpload({ fileName: file.name, done: 0, total: 1 });
    try {
      const parsed = await readDataFile(file);
      const parts = splitParts(parsed.rows);
      const id = loadId();
      let offset = 0;
      let rowCount = 0;
      setUpload({ fileName: file.name, done: 0, total: parts.length });
      for (let i = 0; i < parts.length; i++) {
        const res = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: file.name,
            mimeType: file.type || undefined,
            loadId: id,
            rowOffset: offset,
            columns: parsed.columns,
            rows: parts[i],
            final: i === parts.length - 1,
          }),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string; rowCount?: number };
        if (!res.ok) throw new Error(j.error || `Erreur ${res.status}`);
        offset += parts[i].length;
        if (typeof j.rowCount === "number") rowCount = j.rowCount;
        setUpload({ fileName: file.name, done: i + 1, total: parts.length });
      }
      const extra = parsed.ignoredSheets.length ? ` Seule la 1re feuille (« ${parsed.sheetName} ») a été importée.` : "";
      setNotice({
        tone: "ok",
        fileName: file.name,
        text: `« ${file.name} » importé : ${(rowCount || offset).toLocaleString("fr-FR")} lignes, ${parsed.columns.length} colonnes. L'assistant peut maintenant s'en servir.${extra}`,
      });
      await refresh();
      return file.name;
    } catch (e) {
      setNotice({ tone: "error", text: e instanceof Error ? e.message : "Import impossible" });
      return null;
    } finally {
      setUpload(null);
    }
  }, [base, refresh]);

  const removeFile = useCallback(async (f: BotFile) => {
    if (!confirm(`Retirer « ${f.name} » ? L'assistant ne pourra plus s'en servir.`)) return;
    const res = await fetch(base, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ datasetKey: f.datasetKey }) });
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) { setNotice({ tone: "error", text: j.error || "Retrait impossible" }); return; }
    await refresh();
  }, [base, refresh]);

  return { files, upload, notice, setNotice, importFile, removeFile };
}

/** Paperclip button of the composer (hidden file input). */
export function AttachFileButton({ disabled, uploading, onFile }: { disabled?: boolean; uploading: boolean; onFile: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={UPLOAD_ACCEPT}
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f); }}
      />
      <button
        type="button"
        onClick={() => ref.current?.click()}
        disabled={disabled || uploading}
        aria-label="Importer un fichier de données"
        title="Importer un fichier de données (CSV ou Excel) — l'assistant pourra l'analyser"
        className="h-9 w-9 shrink-0 flex items-center justify-center rounded-lg text-ui-muted hover:text-ui-fg hover:bg-ui-raised disabled:opacity-40 transition-colors duration-150"
      >
        {uploading ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} /> : <Paperclip className="w-4 h-4" strokeWidth={1.5} />}
      </button>
    </>
  );
}

/** Sidebar list: the files the client imported from the chat (team Drive files are not listed). */
export function BotFilesList({ files, onRemove }: { files: BotFile[]; onRemove: (f: BotFile) => void }) {
  if (!files.length) return null;
  return (
    <div className="px-2 pb-2">
      <div className="px-2 pt-2 pb-2 text-xs text-ui-muted">Vos fichiers de données</div>
      {files.map((f) => (
        <div key={f.datasetKey} className="group flex items-center gap-2.5 h-12 px-2 rounded-lg text-ui-fg2 hover:bg-ui-raised/60 transition-colors duration-150" title={f.columns.join(" · ")}>
          <span className="w-4 shrink-0 flex justify-center"><FileSpreadsheet className="w-4 h-4 text-ui-muted" strokeWidth={1.5} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-sm truncate text-ui-fg">{f.name}</div>
            <div className="text-xs text-ui-muted font-mono tabular-nums">{f.rowCount.toLocaleString("fr-FR")} lignes</div>
          </div>
          {f.uploaded && (
            <button type="button" aria-label={`Retirer ${f.name}`} onClick={() => onRemove(f)} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-ui-muted hover:text-ui-neg transition-[opacity,color] duration-150">
              <Trash2 className="w-4 h-4" strokeWidth={1.5} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
