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
    <aside data-pages-rail className={`flex flex-col rounded-xl border border-ui-line bg-ui-bg/85 backdrop-blur-xl shadow-2xl text-ui-fg overflow-hidden ${className ?? ""}`}>
      <div className="px-3 pt-3 pb-2 flex items-center justify-between">
        <span className="text-[10px] text-ui-muted">Pages</span>
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={onNewClient} title="Nouvelle page client" className="p-1 rounded-md text-ui-fg2 hover:text-ui-fg hover:bg-ui-raised"><Briefcase className="w-3.5 h-3.5" /></button>
          <button type="button" onClick={onNewFree} title="Nouvelle page" className="p-1 rounded-md text-ui-fg2 hover:text-ui-fg hover:bg-ui-raised"><Plus className="w-3.5 h-3.5" /></button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto mo-scroll px-1.5 pb-2 space-y-3">
        {!pages ? <div className="px-2 py-3 text-[12px] text-ui-muted">Chargement…</div> : (
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
      <div className="px-2 pb-1 text-[10px] text-ui-muted">{label}</div>
      {children.length ? children : <div className="px-2 py-1 text-[11px] text-ui-muted leading-snug">{empty}</div>}
    </div>
  );
}

function Row({ page, active, editing, onOpen, onEdit, onRename, onArchive, onEditEnd }: { page: MoPageSummary; active: boolean; editing: boolean; onOpen: (id: string) => void; onEdit: () => void; onRename: (id: string, title: string) => void; onArchive: (id: string) => void; onEditEnd: () => void }) {
  const title = pageTitle(page);
  const Icon = page.kind === "home" ? Sun : page.kind === "client" ? Briefcase : FileText;
  const color = page.kind === "client" && page.clientId ? frameColorFor(page.clientId) : null;
  return (
    <div data-page-row={page.id} data-page-kind={page.kind} className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] cursor-pointer ${active ? "bg-ui-raised text-ui-fg" : "text-ui-fg2 hover:bg-ui-raised hover:text-ui-fg"}`} onClick={() => { if (!editing) onOpen(page.id); }} onDoubleClick={(e) => { if (page.kind !== "home") { e.preventDefault(); onEdit(); } }}>
      {color ? <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} /> : <Icon className={`w-3.5 h-3.5 shrink-0 ${page.kind === "home" ? "text-ui-accent-ink" : "text-ui-muted"}`} />}
      {editing ? (
        <RenameInput initial={title} onCommit={(t) => { if (t && t !== title) onRename(page.id, t); onEditEnd(); }} onCancel={onEditEnd} />
      ) : (
        <span className="flex-1 min-w-0 truncate" title={title}>{title}</span>
      )}
      {!editing && page.cards > 0 && <span className="text-[10px] text-ui-muted tabular-nums shrink-0 group-hover:hidden">{page.cards}</span>}
      {!editing && page.kind !== "home" && (
        <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
          <button type="button" onClick={(e) => { e.stopPropagation(); onEdit(); }} title="Renommer" className="p-0.5 rounded text-ui-muted hover:text-ui-fg"><Pencil className="w-3 h-3" /></button>
          <button type="button" onClick={(e) => { e.stopPropagation(); onArchive(page.id); }} title="Archiver" className="p-0.5 rounded text-ui-muted hover:text-rose-300"><Archive className="w-3 h-3" /></button>
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
      className="flex-1 min-w-0 bg-ui-raised rounded px-1.5 py-0.5 text-[12px] text-ui-fg outline-none border border-ui-accent" />
  );
}
