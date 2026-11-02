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
        ? <button type="button" onClick={(e) => { e.stopPropagation(); toggle(); }} title="Ajouter à un board d'inspiration" className="inline-flex items-center gap-1 rounded-md border border-gray-700 px-2 py-1 text-gray-200 hover:text-white hover:border-gray-500"><FolderPlus className="w-3 h-3" />Board</button>
        : <button type="button" onClick={toggle} className={PILL}><FolderPlus className="w-4 h-4 text-gray-400" />Ajouter à un board</button>
    )}>
      <div onClick={(e) => e.stopPropagation()}>
        <MenuLabel>Boards d&apos;inspiration</MenuLabel>
        {!boards ? <div className="h-8 flex items-center gap-2 px-2.5 text-sm text-gray-500"><Loader2 className="w-3.5 h-3.5 animate-spin" />Chargement…</div>
          : boards.length === 0 ? <div className="px-2.5 py-1.5 text-xs text-gray-500">Aucun board : crée le premier ci-dessous.</div>
          : <div className="max-h-56 overflow-y-auto">{boards.map((b) => (
            <MenuItem key={b.id} onClick={() => void add(b.id)}><span className="flex-1 truncate">{b.name}</span>{b.clientId ? null : <span className="text-[10px] text-gray-500">agence</span>}{done.has(b.id) && <Check className="w-3.5 h-3.5 text-emerald-300" />}</MenuItem>
          ))}</div>}
        <div className="border-t border-gray-800 mt-1 p-1.5 flex gap-1">
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} placeholder="Nouveau board…" className="flex-1 h-8 rounded-lg border border-gray-800 bg-gray-900 px-2 text-sm text-white placeholder:text-gray-600" />
          <button type="button" onClick={() => void create()} disabled={!name.trim()} className="h-8 px-2 rounded-lg bg-white text-gray-900 disabled:opacity-40"><Plus className="w-4 h-4" /></button>
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
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} placeholder="Nom du nouveau board (ex. Accroches UGC, Offres Black Friday…)" className="flex-1 h-9 rounded-[10px] border border-gray-800 bg-gray-900 px-3 text-sm text-white placeholder:text-gray-600" />
        {clientId && <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer"><input type="checkbox" className="accent-violet-500" checked={forAgency} onChange={(e) => setForAgency(e.target.checked)} />Pour toute l&apos;agence</label>}
        <button type="button" onClick={() => void create()} disabled={!name.trim()} className="h-9 inline-flex items-center gap-1.5 rounded-[10px] bg-white px-3 text-sm font-medium text-gray-900 hover:bg-gray-200 disabled:opacity-40"><Plus className="w-4 h-4" />Créer le board</button>
      </div>
      {!boards ? <div className="py-16 flex items-center justify-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Chargement des boards…</div>
        : boards.length === 0 ? (
          <div className="py-16 text-center max-w-md mx-auto">
            <FolderPlus className="w-6 h-6 mx-auto text-violet-300" />
            <div className="mt-2 text-base font-semibold text-white">Aucun board pour l&apos;instant</div>
            <p className="mt-1 text-sm text-gray-400">Crée un board, puis ajoute-y des pubs depuis Concurrents (bibliothèque Meta) ou depuis la fiche d&apos;une créa{clientName ? ` de ${clientName}` : ""}.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {boards.map((b) => (
              <button key={b.id} type="button" onClick={() => setOpenId(b.id)} className="text-left rounded-2xl border border-gray-800 bg-gray-900 hover:border-gray-700 overflow-hidden">
                <div className="aspect-[4/3] grid grid-cols-2 grid-rows-2 gap-0.5 bg-gray-950">
                  {Array.from({ length: 4 }).map((_, i) => { const c = b.covers[i]; const src = c ? imgSrc(c.source, c.imageUrl) : null; return src
                    // eslint-disable-next-line @next/next/no-img-element -- platform CDNs
                    ? <img key={i} src={src} alt="" className="w-full h-full object-cover" loading="lazy" />
                    : <div key={i} className="bg-gray-900" />; })}
                </div>
                <div className="px-3 py-2.5">
                  <div className="text-sm font-semibold text-white truncate">{b.name}</div>
                  <div className="text-xs text-gray-500">{b.count} pub{b.count > 1 ? "s" : ""}{b.clientId ? "" : " · agence"}</div>
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
        <h2 className="text-lg font-semibold text-white">{board?.name ?? "…"}</h2>
        <span className="text-sm text-gray-500">{board ? `${board.items.length} pub${board.items.length > 1 ? "s" : ""}` : ""}</span>
        {board && <button type="button" onClick={() => void removeBoard()} className="ml-auto inline-flex items-center gap-1 text-xs text-gray-500 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" />Supprimer le board</button>}
      </div>
      {!board ? <div className="py-16 flex items-center justify-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /></div>
        : board.items.length === 0 ? <div className="py-16 text-center text-sm text-gray-500">Board vide : ajoute des pubs depuis Concurrents ou depuis la fiche d&apos;une créa (« Ajouter à un board »).</div>
        : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {board.items.map((it) => {
              const src = imgSrc(it.source, it.imageUrl);
              return (
                <div key={it.id} className="rounded-2xl border border-gray-800 bg-gray-900 overflow-hidden flex flex-col">
                  <div className="relative aspect-[4/5] bg-gray-950">
                    {/* eslint-disable-next-line @next/next/no-img-element -- platform CDNs */}
                    {src ? <img src={src} alt="" className="absolute inset-0 w-full h-full object-cover" loading="lazy" /> : <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-600">Pas d&apos;aperçu</div>}
                    <span className="absolute left-2 bottom-2 rounded-md bg-black/50 px-2 py-0.5 text-xs text-white">{it.source === "adlib" ? "Concurrent" : "Client"}{it.videoUrl ? " · vidéo" : ""}</span>
                    <button type="button" onClick={() => void patch(it.id, { pinned: !it.pinned })} title={it.pinned ? "Désépingler" : "Épingler en tête du board"} className={`absolute right-2 top-2 w-8 h-8 rounded-full flex items-center justify-center ${it.pinned ? "bg-violet-500 text-white" : "bg-black/50 text-white/80 hover:bg-black/70"}`}><Pin className="w-4 h-4" /></button>
                  </div>
                  <div className="p-3 flex-1 flex flex-col gap-1.5 text-xs">
                    <div className="text-sm font-medium text-white truncate">{it.brand || "—"}</div>
                    {it.title && <div className="text-gray-300 line-clamp-1">{it.title}</div>}
                    {it.body && <div className="text-gray-400 line-clamp-3">{it.body}</div>}
                    <textarea defaultValue={it.note} onBlur={(e) => { if (e.target.value !== it.note) void patch(it.id, { note: e.target.value }); }} placeholder="Note : ce qu'on garde de cette pub…" rows={2} className="mt-1 w-full rounded-lg border border-gray-800 bg-gray-950 px-2 py-1.5 text-xs text-gray-200 placeholder:text-gray-600 resize-none" />
                    <div className="mt-auto flex items-center justify-between pt-1 text-gray-500">
                      <span className="truncate">{it.addedByName}</span>
                      <span className="flex items-center gap-2">
                        {it.linkUrl && <a href={it.linkUrl} target="_blank" rel="noopener noreferrer" className="hover:text-white" title="Ouvrir"><ExternalLink className="w-3.5 h-3.5" /></a>}
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
