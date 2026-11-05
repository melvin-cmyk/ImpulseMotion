"use client";

/**
 * Inspiration boards (Motion's Inspo): « Ajouter à un board » (competitors'
 * ads from the Meta Ad Library and the client's own ads) and the Inspiration
 * page — boards of the client + agency-wide boards, a board's saved ads with
 * a note, pin and removal.
 */

import { useEffect, useState } from "react";
import { ArrowLeft, Check, ExternalLink, FolderPlus, Loader2, Pin, Plus, Trash2 } from "lucide-react";
import { MenuItem, MenuLabel, PILL, Popover } from "./pill";

export interface InspoPayload { source: "adlib" | "own"; ref: string; brand?: string; title?: string | null; body?: string | null; imageUrl?: string | null; videoUrl?: string | null; linkUrl?: string | null }
interface BoardSummary { id: string; name: string; description: string; clientId: string | null; count: number; covers: Array<{ imageUrl: string | null; source: string }> }
interface Item { id: string; source: string; ref: string; brand: string; title: string | null; body: string | null; imageUrl: string | null; videoUrl: string | null; linkUrl: string | null; note: string; pinned: boolean; addedByName: string; createdAt: string }

const imgSrc = (source: string, url: string | null) => (!url ? null : source === "adlib" && /^https:/.test(url) ? `/api/media/proxy-image?url=${encodeURIComponent(url)}` : url);

async function loadBoards(clientId: string | null): Promise<BoardSummary[]> {
  const r = await fetch(`/api/inspo/boards${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ""}`);
  return r.ok ? ((await r.json()) as { boards: BoardSummary[] }).boards : [];
}

/** « Ajouter à un board » popover. */
export function SaveToBoard({ payload, clientId, compact }: { payload: () => InspoPayload; clientId: string | null; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  useEffect(() => { if (open) void loadBoards(clientId).then(setBoards); }, [open, clientId]);
  async function add(boardId: string) {
    const r = await fetch(`/api/inspo/boards/${boardId}/items`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()) });
    if (r.ok) setDone((s) => new Set(s).add(boardId));
  }
  async function create() {
    if (!name.trim()) return;
    const r = await fetch("/api/inspo/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), clientId }) });
    if (!r.ok) return;
    const { board } = (await r.json()) as { board: BoardSummary };
    setBoards((b) => [board, ...(b ?? [])]); setName("");
    await add(board.id);
  }
  return (
    <Popover width={260} align="right" open={open} onOpenChange={setOpen} trigger={({ toggle }) => (
      compact
        ? <button type="button" onClick={(e) => { e.stopPropagation(); toggle(); }} title="Ajouter à un board d'inspiration" className="inline-flex items-center gap-1 rounded-md border border-ui-line-strong px-2 py-1 text-ui-fg hover:text-ui-fg hover:border-ui-line-strong"><FolderPlus className="w-3 h-3" />Board</button>
        : <button type="button" onClick={toggle} className={PILL}><FolderPlus className="w-4 h-4 text-ui-fg2" />Ajouter à un board</button>
    )}>
      <div onClick={(e) => e.stopPropagation()}>
        <MenuLabel>Boards d&apos;inspiration</MenuLabel>
        {!boards ? <div className="h-8 flex items-center gap-2 px-2.5 text-sm text-ui-muted"><Loader2 className="w-3.5 h-3.5 animate-spin" />Chargement…</div>
          : boards.length === 0 ? <div className="px-2.5 py-1.5 text-xs text-ui-muted">Aucun board : crée le premier ci-dessous.</div>
          : <div className="max-h-56 overflow-y-auto">{boards.map((b) => (
            <MenuItem key={b.id} onClick={() => void add(b.id)}><span className="flex-1 truncate">{b.name}</span>{b.clientId ? null : <span className="text-[10px] text-ui-muted">agence</span>}{done.has(b.id) && <Check className="w-3.5 h-3.5 text-emerald-300" />}</MenuItem>
          ))}</div>}
        <div className="border-t border-ui-line mt-1 p-1.5 flex gap-1">
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} placeholder="Nouveau board…" className="flex-1 h-8 rounded-lg border border-ui-line bg-ui-card px-2 text-sm text-ui-fg placeholder:text-ui-muted" />
          <button type="button" onClick={() => void create()} disabled={!name.trim()} className="h-8 px-2 rounded-lg bg-ui-inverse text-ui-on-inverse disabled:opacity-40"><Plus className="w-4 h-4" /></button>
        </div>
      </div>
    </Popover>
  );
}

/** Inspiration page: boards, then a board's saved ads. */
export function InspoPanel({ clientId, clientName }: { clientId: string | null; clientName: string | null }) {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [forAgency, setForAgency] = useState(false);
  const reload = () => { void loadBoards(clientId).then(setBoards); };
  useEffect(reload, [clientId]);  

  async function create() {
    if (!name.trim()) return;
    const r = await fetch("/api/inspo/boards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), clientId: forAgency ? null : clientId }) });
    if (r.ok) { setName(""); reload(); }
  }
  if (openId) return <BoardView id={openId} onBack={() => { setOpenId(null); reload(); }} />;

  return (
    <div className="px-6 pb-10">
      <div className="flex items-center gap-2 mb-5">
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} placeholder="Nom du nouveau board (ex. Accroches UGC, Offres Black Friday…)" className="flex-1 h-9 rounded-[10px] border border-ui-line bg-ui-card px-3 text-sm text-ui-fg placeholder:text-ui-muted" />
        {clientId && <label className="flex items-center gap-1.5 text-xs text-ui-fg2 cursor-pointer"><input type="checkbox" className="accent-ui-accent" checked={forAgency} onChange={(e) => setForAgency(e.target.checked)} />Pour toute l&apos;agence</label>}
        <button type="button" onClick={() => void create()} disabled={!name.trim()} className="h-9 inline-flex items-center gap-1.5 rounded-[10px] bg-ui-inverse px-3 text-sm font-medium text-ui-on-inverse hover:opacity-90 disabled:opacity-40"><Plus className="w-4 h-4" />Créer le board</button>
      </div>
      {!boards ? <div className="py-16 flex items-center justify-center gap-2 text-sm text-ui-fg2"><Loader2 className="w-4 h-4 animate-spin" /> Chargement des boards…</div>
        : boards.length === 0 ? (
          <div className="py-16 text-center max-w-md mx-auto">
            <FolderPlus className="w-6 h-6 mx-auto text-ui-accent-ink" />
            <div className="mt-2 text-base font-medium text-ui-fg">Aucun board pour l&apos;instant</div>
            <p className="mt-1 text-sm text-ui-fg2">Crée un board, puis ajoute-y des pubs depuis Concurrents (bibliothèque Meta) ou depuis la fiche d&apos;une créa{clientName ? ` de ${clientName}` : ""}.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {boards.map((b) => (
              <button key={b.id} type="button" onClick={() => setOpenId(b.id)} className="text-left rounded-xl border border-ui-line bg-ui-card hover:border-ui-line-strong overflow-hidden">
                <div className="aspect-[4/3] grid grid-cols-2 grid-rows-2 gap-0.5 bg-ui-bg">
                  {Array.from({ length: 4 }).map((_, i) => { const c = b.covers[i]; const src = c ? imgSrc(c.source, c.imageUrl) : null; return src
                    // eslint-disable-next-line @next/next/no-img-element -- platform CDNs
                    ? <img key={i} src={src} alt="" className="w-full h-full object-cover" loading="lazy" />
                    : <div key={i} className="bg-ui-card" />; })}
                </div>
                <div className="px-3 py-2.5">
                  <div className="text-sm font-medium text-ui-fg truncate">{b.name}</div>
                  <div className="text-xs text-ui-muted">{b.count} pub{b.count > 1 ? "s" : ""}{b.clientId ? "" : " · agence"}</div>
                </div>
              </button>
            ))}
          </div>
        )}
    </div>
  );
}

function BoardView({ id, onBack }: { id: string; onBack: () => void }) {
  const [board, setBoard] = useState<{ id: string; name: string; description: string; items: Item[] } | null>(null);
  const load = () => { void fetch(`/api/inspo/boards/${id}`).then((r) => (r.ok ? r.json() : null)).then((j) => setBoard(j?.board ?? null)); };
  useEffect(load, [id]);  
  const patch = async (itemId: string, body: Record<string, unknown>) => { await fetch(`/api/inspo/boards/${id}/items/${itemId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); load(); };
  const remove = async (itemId: string) => { await fetch(`/api/inspo/boards/${id}/items/${itemId}`, { method: "DELETE" }); load(); };
  async function removeBoard() { if (!board || !confirm(`Supprimer le board « ${board.name} » et ses ${board.items.length} pubs ?`)) return; await fetch(`/api/inspo/boards/${id}`, { method: "DELETE" }); onBack(); }

  return (
    <div className="px-6 pb-10">
      <div className="flex items-center gap-2 mb-5">
        <button type="button" onClick={onBack} className={PILL}><ArrowLeft className="w-4 h-4" />Boards</button>
        <h2 className="text-lg font-medium text-ui-fg">{board?.name ?? "…"}</h2>
        <span className="text-sm text-ui-muted">{board ? `${board.items.length} pub${board.items.length > 1 ? "s" : ""}` : ""}</span>
        {board && <button type="button" onClick={() => void removeBoard()} className="ml-auto inline-flex items-center gap-1 text-xs text-ui-muted hover:text-red-400"><Trash2 className="w-3.5 h-3.5" />Supprimer le board</button>}
      </div>
      {!board ? <div className="py-16 flex items-center justify-center gap-2 text-sm text-ui-fg2"><Loader2 className="w-4 h-4 animate-spin" /></div>
        : board.items.length === 0 ? <div className="py-16 text-center text-sm text-ui-muted">Board vide : ajoute des pubs depuis Concurrents ou depuis la fiche d&apos;une créa (« Ajouter à un board »).</div>
        : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {board.items.map((it) => {
              const src = imgSrc(it.source, it.imageUrl);
              return (
                <div key={it.id} className="rounded-xl border border-ui-line bg-ui-card overflow-hidden flex flex-col">
                  <div className="relative aspect-[4/5] bg-ui-bg">
                    {/* eslint-disable-next-line @next/next/no-img-element -- platform CDNs */}
                    {src ? <img src={src} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" /> : <div className="absolute inset-0 flex items-center justify-center text-xs text-ui-muted">Pas d&apos;aperçu</div>}
                    <span className="absolute left-2 bottom-2 rounded-md bg-black/50 px-2 py-0.5 text-xs text-ui-fg">{it.source === "adlib" ? "Concurrent" : "Client"}{it.videoUrl ? " · vidéo" : ""}</span>
                    <button type="button" onClick={() => void patch(it.id, { pinned: !it.pinned })} title={it.pinned ? "Désépingler" : "Épingler en tête du board"} className={`absolute right-2 top-2 w-8 h-8 rounded-full flex items-center justify-center ${it.pinned ? "bg-ui-accent text-ui-on-accent" : "bg-black/50 text-ui-fg2 hover:bg-black/50"}`}><Pin className="w-4 h-4" /></button>
                  </div>
                  <div className="p-3 flex-1 flex flex-col gap-1.5 text-xs">
                    <div className="text-sm font-medium text-ui-fg truncate">{it.brand || "—"}</div>
                    {it.title && <div className="text-ui-fg2 line-clamp-1">{it.title}</div>}
                    {it.body && <div className="text-ui-fg2 line-clamp-3">{it.body}</div>}
                    <textarea defaultValue={it.note} onBlur={(e) => { if (e.target.value !== it.note) void patch(it.id, { note: e.target.value }); }} placeholder="Note : ce qu'on garde de cette pub…" rows={2} className="mt-1 w-full rounded-lg border border-ui-line bg-ui-bg px-2 py-1.5 text-xs text-ui-fg placeholder:text-ui-muted resize-none" />
                    <div className="mt-auto flex items-center justify-between pt-1 text-ui-muted">
                      <span className="truncate">{it.addedByName}</span>
                      <span className="flex items-center gap-2">
                        {it.linkUrl && <a href={it.linkUrl} target="_blank" rel="noopener noreferrer" className="hover:text-ui-fg" title="Ouvrir"><ExternalLink className="w-3.5 h-3.5" /></a>}
                        <button type="button" onClick={() => void remove(it.id)} className="hover:text-red-400" title="Retirer du board"><Trash2 className="w-3.5 h-3.5" /></button>
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}
