/**
 * The pages of a consultant's Mo workspace (pure, client-safe): « Aujourd'hui »
 * (kind home, one per person, never archived), one page per client (kind
 * client, created on demand or when a frame is detached), free pages (kind
 * free: every old session, nothing lost). Stored as MoBoard rows.
 */

export type MoPageKind = "home" | "client" | "free";
export const HOME_TITLE = "Aujourd'hui";
export const FREE_TITLE = "Page sans titre";

export interface MoPageSummary {
  id: string;
  title: string;
  kind: MoPageKind;
  clientId: string | null;
  /** Name of the client in the registry (a client page), when known. */
  clientName?: string;
  updatedAt: string;
  cards: number;
  archived: boolean;
  position: number;
}

export interface MoPages { home: MoPageSummary; client: MoPageSummary[]; free: MoPageSummary[] }

export const pageKindOf = (kind: string | null | undefined): MoPageKind => (kind === "home" || kind === "client" ? kind : "free");

/** The title shown for a page: the home title, the client's name, the page's own title, or a placeholder. */
export function pageTitle(p: Pick<MoPageSummary, "kind" | "title" | "clientName">): string {
  if (p.kind === "home") return HOME_TITLE;
  return p.title.trim() || p.clientName || FREE_TITLE;
}

/**
 * Groups the rows of a person into the rail's sections: the home page first,
 * client pages by position then name, free pages most recent first. Archived
 * pages are left out unless `withArchived`. The home row is required (the
 * server creates it on first use).
 */
export function groupPages(rows: MoPageSummary[], withArchived = false): MoPages | null {
  const home = rows.find((r) => r.kind === "home");
  if (!home) return null;
  const live = rows.filter((r) => r !== home && (withArchived || !r.archived));
  const byName = (a: MoPageSummary, b: MoPageSummary) => pageTitle(a).localeCompare(pageTitle(b), "fr");
  return {
    home: { ...home, title: HOME_TITLE },
    client: live.filter((r) => r.kind === "client").sort((a, b) => a.position - b.position || byName(a, b)),
    free: live.filter((r) => r.kind === "free").sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0)),
  };
}

export type CreatePageBody = { kind: "free"; title?: string } | { kind: "client"; clientId: string } | { kind: "home" };

/** The body of POST /api/mo read with care: kind free (default, optional title), client (its id), or home. */
export function parseCreatePage(raw: unknown): CreatePageBody | { error: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = r.kind === undefined ? "free" : r.kind;
  if (kind === "home") return { kind: "home" };
  if (kind === "free") {
    const title = typeof r.title === "string" ? r.title.trim().slice(0, 80) : "";
    return title ? { kind: "free", title } : { kind: "free" };
  }
  if (kind === "client") {
    const clientId = typeof r.clientId === "string" ? r.clientId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(clientId)) return { error: "clientId requis" };
    return { kind: "client", clientId };
  }
  return { error: "kind inconnu (home | client | free)" };
}
