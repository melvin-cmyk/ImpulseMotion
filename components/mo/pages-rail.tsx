"use client";

/**
 * The pages rail of Mo (left, collapsible): « Aujourd'hui », then one page per
 * client, then the free pages. Create (a free page, or a client page through
 * the palette), rename (double-click, or the pencil), archive (hover).
 */

import { useState } from "react";
import { Archive, Briefcase, FileText, Pencil, Plus, Sun } from "lucide-react";
import { pageTitle, type MoPageSummary, type MoPages } from "@/lib/mo/pages";
import { frameColorFor } from "@/lib/mo/frames";

interface Props {
  pages: MoPages | null;
  currentId: string | null;
  onOpen: (id: string) => void;
  onNewFree: () => void;
  onNewClient: () => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  className?: string;
}

export function PagesRail({ pages, currentId, onOpen, onNewFree, onNewClient, onRename, onArchive, className }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <aside data-pages-rail className={`flex flex-col rounded-2xl border border-white/10 bg-[#0d0a1a]/85 backdrop-blur-xl shadow-2xl text-gray-200 overflow-hidden ${className ?? ""}`}>
      <div className="px-3 pt-3 pb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-gray-500">Pages</span>
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={onNewClient} title="Nouvelle page client" className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-white/10"><Briefcase className="w-3.5 h-3.5" /></button>
          <button type="button" onClick={onNewFree} title="Nouvelle page" className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-white/10"><Plus className="w-3.5 h-3.5" /></button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto mo-scroll px-1.5 pb-2 space-y-3">
        {!pages ? <div className="px-2 py-3 text-[12px] text-gray-500">Chargement…</div> : (
          <>
            <Row page={pages.home} active={pages.home.id === currentId} editing={false} onOpen={onOpen} onEdit={() => undefined} onRename={onRename} onArchive={onArchive} onEditEnd={() => undefined} />
            <Section label="Clients" empty="Aucune page client — ⌘K ou le cadre d'un client → « Détacher en page »">
              {pages.client.map((p) => <Row key={p.id} page={p} active={p.id === currentId} editing={editing === p.id} onOpen={onOpen} onEdit={() => setEditing(p.id)} onRename={onRename} onArchive={onArchive} onEditEnd={() => setEditing(null)} />)}
            </Section>
            <Section label="Pages libres" empty="Aucune page libre">
              {pages.free.map((p) => <Row key={p.id} page={p} active={p.id === currentId} editing={editing === p.id} onOpen={onOpen} onEdit={() => setEditing(p.id)} onRename={onRename} onArchive={onArchive} onEditEnd={() => setEditing(null)} />)}
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}

function Section({ label, empty, children }: { label: string; empty: string; children: React.ReactNode[] }) {
  return (
    <div>
      <div className="px-2 pb-1 text-[10px] uppercase tracking-wider text-gray-600">{label}</div>
      {children.length ? children : <div className="px-2 py-1 text-[11px] text-gray-600 leading-snug">{empty}</div>}
    </div>
  );
}

function Row({ page, active, editing, onOpen, onEdit, onRename, onArchive, onEditEnd }: { page: MoPageSummary; active: boolean; editing: boolean; onOpen: (id: string) => void; onEdit: () => void; onRename: (id: string, title: string) => void; onArchive: (id: string) => void; onEditEnd: () => void }) {
  const title = pageTitle(page);
  const Icon = page.kind === "home" ? Sun : page.kind === "client" ? Briefcase : FileText;
  const color = page.kind === "client" && page.clientId ? frameColorFor(page.clientId) : null;
  return (
    <div data-page-row={page.id} data-page-kind={page.kind} className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] cursor-pointer ${active ? "bg-white/10 text-white" : "text-gray-300 hover:bg-white/5 hover:text-white"}`} onClick={() => { if (!editing) onOpen(page.id); }} onDoubleClick={(e) => { if (page.kind !== "home") { e.preventDefault(); onEdit(); } }}>
      {color ? <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} /> : <Icon className={`w-3.5 h-3.5 shrink-0 ${page.kind === "home" ? "text-violet-300" : "text-gray-500"}`} />}
      {editing ? (
        <RenameInput initial={title} onCommit={(t) => { if (t && t !== title) onRename(page.id, t); onEditEnd(); }} onCancel={onEditEnd} />
      ) : (
        <span className="flex-1 min-w-0 truncate" title={title}>{title}</span>
      )}
      {!editing && page.cards > 0 && <span className="text-[10px] text-gray-600 tabular-nums shrink-0 group-hover:hidden">{page.cards}</span>}
      {!editing && page.kind !== "home" && (
        <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
          <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(); }} title="Renommer" className="p-0.5 rounded text-gray-500 hover:text-white"><Pencil className="w-3 h-3" /></button>
          <button type="button" onClick={(e) => { e.stopPropagation(); onArchive(page.id); }} title="Archiver" className="p-0.5 rounded text-gray-500 hover:text-rose-300"><Archive className="w-3 h-3" /></button>
        </span>
      )}
    </div>
  );
}

/** The rename field: mounted while editing, so its draft starts from the title each time. */
function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (title: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  return (
    <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onFocus={(e) => e.currentTarget.select()} onBlur={() => onCommit(draft.trim())}
      onKeyDown={(e) => { if (e.key === "Enter") onCommit(draft.trim()); if (e.key === "Escape") onCancel(); e.stopPropagation(); }} onClick={(e) => e.stopPropagation()}
      className="flex-1 min-w-0 bg-white/10 rounded px-1.5 py-0.5 text-[12px] text-white outline-none border border-violet-400/50" />
  );
}
