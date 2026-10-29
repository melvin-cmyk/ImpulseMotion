"use client";

/**
 * ⌘K on Mo: the client palette of the app (components/client-palette.tsx)
 * with Mo's rows — clients (↵ focuses the client's frame on this page, else
 * opens its page), actions (« Créas de … cette semaine », « Chiffres de … ce
 * mois-ci », « Nouvelle page client », « Ranger » (en ligne, en colonne), « Tout voir », « Publier la
 * sélection »), pages. In « client page » mode (from the rail), picking a
 * client creates / opens its page.
 */

import { useEffect, useMemo, useState } from "react";
import { ClientPalette, type ClientRow, type PaletteCommand } from "@/components/client-palette";
import type { ArrangeLayout } from "@/lib/mo/geometry";
import { pageTitle, type MoPages } from "@/lib/mo/pages";

export type PaletteMode = "all" | "client-page";

export interface MoPaletteProps {
  open: boolean;
  mode: PaletteMode;
  /** « Nouvelle page client » picked: the palette asks the page to switch it to client-page mode. */
  onMode: (mode: PaletteMode) => void;
  onClose: () => void;
  pages: MoPages | null;
  currentId: string | null;
  /** Clients with a frame on the current page (name shown in the actions). */
  framed: Array<{ clientId: string; clientName: string }>;
  hasSelection: boolean;
  onPickClient: (client: ClientRow, mode: PaletteMode) => void;
  onOpenPage: (id: string) => void;
  onNewFree: () => void;
  onSend: (text: string) => void;
  /** « Ranger » : the masonry by default, `row` = one line, `column` = one column. */
  onArrange: (layout?: ArrangeLayout) => void;
  onFitAll: () => void;
  onPublishSelection: () => void;
}

export function MoPalette({ open, mode, onMode, onClose, pages, currentId, framed, hasSelection, onPickClient, onOpenPage, onNewFree, onSend, onArrange, onFitAll, onPublishSelection }: MoPaletteProps) {
  const [clients, setClients] = useState<ClientRow[] | null>(null);
  const clientMode = mode === "client-page";
  // The clients, fetched when the palette opens (the list stays for the next time; `null` = not loaded yet).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/clients", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { clients: [] })).then((j: { clients: ClientRow[] }) => { if (!cancelled) setClients(j.clients ?? []); }).catch(() => { if (!cancelled) setClients((c) => c ?? []); });
    return () => { cancelled = true; };
  }, [open]);
  const loading = clients === null;

  const pageByClient = useMemo(() => new Map((pages?.client ?? []).map((p) => [p.clientId, p])), [pages]);
  const commands = useMemo<PaletteCommand[]>(() => {
    if (clientMode) return [];
    const run = (fn: () => void) => () => { onClose(); fn(); };
    // The clients at hand: those framed on this page, then those with a page.
    const seen = new Set<string>();
    const near: Array<{ clientId: string; clientName: string }> = [];
    for (const f of framed) if (!seen.has(f.clientId)) { seen.add(f.clientId); near.push(f); }
    for (const p of pages?.client ?? []) if (p.clientId && !seen.has(p.clientId)) { seen.add(p.clientId); near.push({ clientId: p.clientId, clientName: pageTitle(p) }); }
    const actions: PaletteCommand[] = [];
    for (const c of near.slice(0, 12)) {
      actions.push({ id: `creas:${c.clientId}`, group: "Actions", icon: "action", label: `Créas de ${c.clientName} cette semaine`, hint: "sans modèle, 3 secondes", keywords: "creas creatives visuels semaine", onPick: run(() => onSend(`créas de ${c.clientName} cette semaine`)) });
      actions.push({ id: `chiffres:${c.clientId}`, group: "Actions", icon: "action", label: `Chiffres de ${c.clientName} ce mois-ci`, hint: "KPI du mois, sans modèle", keywords: "chiffres kpi metrics mois", onPick: run(() => onSend(`chiffres de ${c.clientName} ce mois-ci`)) });
    }
    actions.push({ id: "new-client-page", group: "Actions", icon: "client", label: "Nouvelle page client", hint: "choisir le client à l'étape suivante", keywords: "page client nouvelle creer", onPick: () => onMode("client-page") });
    actions.push({ id: "new-free-page", group: "Actions", icon: "page", label: "Nouvelle page", hint: "une page libre", keywords: "page libre nouvelle creer", onPick: run(onNewFree) });
    actions.push({ id: "arrange", group: "Actions", icon: "action", label: "Ranger", hint: "cadre par cadre, puis les cartes libres (R)", keywords: "ranger arrange tidy", onPick: run(() => onArrange()) });
    actions.push({ id: "arrange-row", group: "Actions", icon: "action", label: "Ranger en ligne", hint: "toutes les cartes sur une ligne, de gauche à droite, cadres gardés (H)", keywords: "ranger ligne horizontal horizontalement row aligner", onPick: run(() => onArrange("row")) });
    actions.push({ id: "arrange-column", group: "Actions", icon: "action", label: "Ranger en colonne", hint: "toutes les cartes en colonne, de haut en bas, cadres gardés (V)", keywords: "ranger colonne vertical verticalement column empiler", onPick: run(() => onArrange("column")) });
    actions.push({ id: "fit-all", group: "Actions", icon: "action", label: "Tout voir", hint: "⌘0", keywords: "tout voir fit zoom", onPick: run(onFitAll) });
    actions.push({ id: "publish-selection", group: "Actions", icon: "action", label: "Publier la sélection", hint: hasSelection ? "prépare la publication du visuel sélectionné (jamais sans confirmation)" : "sélectionne d'abord une carte de créas", keywords: "publier publication publish meta", onPick: run(onPublishSelection) });
    const pageRows: PaletteCommand[] = [];
    if (pages) {
      pageRows.push({ id: `page:${pages.home.id}`, group: "Pages", icon: "home", label: pageTitle(pages.home), hint: pages.home.id === currentId ? "page ouverte" : "page d'accueil", keywords: "aujourd'hui accueil home", onPick: run(() => onOpenPage(pages.home.id)) });
      for (const p of [...pages.client, ...pages.free]) pageRows.push({ id: `page:${p.id}`, group: "Pages", icon: p.kind === "client" ? "client" : "page", label: pageTitle(p), hint: p.id === currentId ? "page ouverte" : `${p.cards} carte${p.cards > 1 ? "s" : ""}${p.kind === "client" ? " · page client" : ""}`, keywords: "page", onPick: run(() => onOpenPage(p.id)) });
    }
    return [...actions, ...pageRows];
  }, [clientMode, framed, pages, currentId, hasSelection, onClose, onMode, onSend, onNewFree, onArrange, onFitAll, onPublishSelection, onOpenPage]);

  const framedIds = useMemo(() => new Set(framed.map((f) => f.clientId)), [framed]);
  return (
    <ClientPalette
      open={open}
      onClose={onClose}
      clients={clients ?? []}
      accounts={[]}
      loading={loading}
      primary="client"
      title={clientMode ? "Quel client ? (sa page s'ouvre, créée s'il le faut)" : "Client, action (créas, chiffres, ranger…), page…"}
      commands={commands}
      clientHint={clientMode ? "page client" : "cadre / page"}
      clientSubtitle={(c) => (framedIds.has(c.id) ? "cadre sur cette page" : pageByClient.has(c.id) ? "a sa page" : clientMode ? "créer sa page" : "ouvrir / créer sa page")}
      onPickClient={(c) => { const m: PaletteMode = clientMode ? "client-page" : "all"; onClose(); onPickClient(c, m); }}
      onPickAccount={() => onClose()}
    />
  );
}
