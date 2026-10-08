/**
 * Matching the agency's clients (AlertClient, dashboards) with their HQ
 * folder (projects/{slug}), so that everything that reads or writes HQ — the
 * brief before a report, the pilotage journal, the personas — works for every
 * client and not only the one whose slug was typed by hand.
 *
 * Evidence, strongest first:
 *   1. an ad account id found in projects/{slug}/client.yaml (Meta act_… or
 *      Google customer id) — "compte";
 *   2. the normalised client name equal to the registry name (clients.yaml
 *      `nom`), the project name or the slug — "nom";
 *   3. one contained in the other (« Cours Legendre — Cours Legendre 2023 »
 *      vs « Cours Legendre ») — "partiel".
 * Several candidates at the same level = "ambigu": a human chooses. Nothing is
 * written without a click on the admin page (app/admin/hq).
 */

import { prisma } from "@/lib/prisma";
import { readHqFile } from "@/lib/hq-persona";
import { listHqProjects } from "@/lib/hq-journal";
import { normalizeClientName } from "@/lib/hq-client-context";

export interface HqProjectInfo {
  slug: string;
  /** Name in HQ's projects list (often the slug itself). */
  name: string;
  /** `nom` of clients.yaml, when the slug is in the registry. */
  registryName: string | null;
  /** Account ids read in projects/{slug}/client.yaml ("meta:<id>" | "google:<id>"). */
  accounts: string[];
  hasClientYaml: boolean;
}

export type MatchLevel = "compte" | "nom" | "partiel";

export interface MatchSuggestion {
  slug: string;
  level: MatchLevel;
  /** What matched, for the admin to judge ("act_595800441007042", "nom « Cours Legendre »"). */
  evidence: string;
}

export interface ClientMatchRow {
  id: string;
  name: string;
  accounts: Array<{ platform: string; accountId: string }>;
  dashboards: Array<{ id: string; name: string; hqSlug: string | null }>;
  hqSlug: string | null;
  dormant: boolean;
  /** Best suggestion, or null. */
  suggestion: MatchSuggestion | null;
  /** All plausible candidates (the best first); more than one at the top level = ambiguous. */
  candidates: MatchSuggestion[];
  ambiguous: boolean;
}

// ---------------------------------------------------------------------------
// HQ side
// ---------------------------------------------------------------------------

/** `clients:` block of clients.yaml → { slug: nom }. Hand-written YAML, two-space indents. */
export function parseClientsRegistry(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = yaml.split(/\r?\n/);
  let inClients = false;
  let current: string | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^clients:\s*$/.test(line)) { inClients = true; continue; }
    if (!inClients) continue;
    if (/^\S/.test(line) && line.trim()) { inClients = false; continue; } // next top-level block
    const slugM = line.match(/^  ([a-z0-9][a-z0-9-]*):\s*$/);
    if (slugM) { current = slugM[1]; out[current] = out[current] ?? current; continue; }
    const nomM = line.match(/^    nom:\s*(.+)$/);
    if (nomM && current) out[current] = nomM[1].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Account ids of a client.yaml: Meta `account_id: act_…` and Google `cid:` / `customer_id:`. */
export function parseClientYamlAccounts(yaml: string): string[] {
  const out = new Set<string>();
  for (const m of yaml.matchAll(/account_id:\s*["']?(?:act_)?(\d{6,20})["']?/g)) out.add(`meta:${m[1]}`);
  for (const m of yaml.matchAll(/\b(?:cid|customer_id|cID)\s*:\s*["']?([\d-]{9,14})["']?/g)) {
    const digits = m[1].replace(/-/g, "");
    if (/^\d{10}$/.test(digits)) out.add(`google:${digits}`);
  }
  return [...out];
}

const HQ_CACHE_MS = 10 * 60 * 1000;
let registryCache: { at: number; projects: HqProjectInfo[] } | null = null;

/** HQ projects with registry names and account ids; cached 10 min per instance. Throws when HQ is unreachable. */
export async function loadHqProjects(opts: { force?: boolean } = {}): Promise<HqProjectInfo[]> {
  if (!opts.force && registryCache && registryCache.at > Date.now() - HQ_CACHE_MS) return registryCache.projects;
  const list = await listHqProjects();
  if (!list) throw new Error("HQ inaccessible (liste des projets)");
  let registry: Record<string, string> = {};
  try {
    const reg = await readHqFile("clients.yaml");
    if (reg.found) registry = parseClientsRegistry(reg.content);
  } catch { /* the registry is a bonus */ }
  const projects: HqProjectInfo[] = [];
  // A few at a time: each read is one HQ session on the relay.
  const queue = [...list];
  const workers = Array.from({ length: 4 }, async () => {
    for (;;) {
      const p = queue.shift();
      if (!p) return;
      let accounts: string[] = [];
      let hasClientYaml = false;
      try {
        const f = await readHqFile(`projects/${p.slug}/client.yaml`);
        if (f.found) { hasClientYaml = true; accounts = parseClientYamlAccounts(f.content); }
      } catch { /* HQ hiccup on one file */ }
      projects.push({ slug: p.slug, name: p.name || p.slug, registryName: registry[p.slug] ?? null, accounts, hasClientYaml });
    }
  });
  await Promise.all(workers);
  // Registry entries without a project folder are still valid targets (the folder may be created later by /new-client).
  for (const [slug, nom] of Object.entries(registry)) {
    if (!projects.some((p) => p.slug === slug)) projects.push({ slug, name: nom, registryName: nom, accounts: [], hasClientYaml: false });
  }
  projects.sort((a, b) => a.slug.localeCompare(b.slug));
  registryCache = { at: Date.now(), projects };
  return projects;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

const NOISE = new Set(["new", "compte", "account", "fr", "us", "de", "uk", "es", "sa", "ads", "meta", "google", "the", "le", "la", "les"]);

/** Name → comparable key: accents and punctuation out, trailing years / « new » out. */
export function nameKey(name: string): string {
  return normalizeClientName(
    name
      .replace(/\b(19|20)\d{2}\b/g, " ")
      .replace(/\b(new|nouveau|compte|account)\b/gi, " "),
  );
}

/** Tokens of a name, for a partial match that is not a substring accident. */
function tokens(name: string): string[] {
  return name
    .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !NOISE.has(t) && !/^(19|20)\d{2}$/.test(t));
}

export function suggestFor(
  client: { name: string; accounts: Array<{ platform: string; accountId: string }>; dashboards?: Array<{ name: string }> },
  projects: HqProjectInfo[],
): { candidates: MatchSuggestion[]; ambiguous: boolean } {
  const byLevel: Record<MatchLevel, MatchSuggestion[]> = { compte: [], nom: [], partiel: [] };
  const accountKeys = new Set(client.accounts.map((a) => `${a.platform}:${a.accountId}`));
  const names = [client.name, ...(client.dashboards ?? []).map((d) => d.name)];
  const keys = new Set(names.map(nameKey).filter((k) => k.length >= 3));
  const toks = new Set(names.flatMap(tokens));

  for (const p of projects) {
    const hit = p.accounts.find((a) => accountKeys.has(a));
    if (hit) { byLevel.compte.push({ slug: p.slug, level: "compte", evidence: hit.replace("meta:", "act_").replace("google:", "Google ") }); continue; }
    const pNames = [p.registryName, p.name, p.slug.replace(/-[0-9a-f]{8,}$/, "")].filter((n): n is string => !!n);
    const pKeys = pNames.map(nameKey).filter((k) => k.length >= 3);
    const exact = pKeys.find((k) => keys.has(k));
    if (exact) { byLevel.nom.push({ slug: p.slug, level: "nom", evidence: `nom « ${p.registryName ?? p.name} »` }); continue; }
    const pToks = new Set(pNames.flatMap(tokens));
    if (!pToks.size) continue;
    // Partial: every token of the HQ name is in the client's name (or the reverse), and at least one is 4+ chars.
    const hqIn = [...pToks].every((t) => toks.has(t)) && [...pToks].some((t) => t.length >= 4);
    const clientIn = [...toks].length > 0 && [...toks].every((t) => pToks.has(t)) && [...toks].some((t) => t.length >= 4);
    if (hqIn || clientIn) byLevel.partiel.push({ slug: p.slug, level: "partiel", evidence: `proche de « ${p.registryName ?? p.name} »` });
  }

  const top = byLevel.compte.length ? byLevel.compte : byLevel.nom.length ? byLevel.nom : byLevel.partiel;
  const candidates = [...byLevel.compte, ...byLevel.nom, ...byLevel.partiel];
  return { candidates, ambiguous: top.length > 1 };
}

export async function buildMatchRows(projects: HqProjectInfo[]): Promise<ClientMatchRow[]> {
  const [clients, dashboards] = await Promise.all([
    prisma.alertClient.findMany({ where: { gone: false }, select: { id: true, name: true, accountsJson: true, hqSlug: true, dormant: true }, orderBy: { name: "asc" } }),
    prisma.dashboard.findMany({ select: { id: true, name: true, metaAccountId: true, googleCustomerId: true, hqSlug: true } }),
  ]);
  return clients.map((c) => {
    let accounts: Array<{ platform: string; accountId: string }> = [];
    try { accounts = (JSON.parse(c.accountsJson) as Array<{ platform: string; accountId: string }>).filter((a) => a && a.platform && a.accountId); } catch { /* [] */ }
    const keys = new Set(accounts.map((a) => `${a.platform}:${a.accountId}`));
    const ds = dashboards
      .filter((d) => (d.metaAccountId && keys.has(`meta:${d.metaAccountId}`)) || (d.googleCustomerId && keys.has(`google:${d.googleCustomerId}`)))
      .map((d) => ({ id: d.id, name: d.name, hqSlug: d.hqSlug }));
    const { candidates, ambiguous } = suggestFor({ name: c.name, accounts, dashboards: ds }, projects);
    // A slug already set on one of its dashboards is the best hint of all.
    const fromDashboard = ds.find((d) => d.hqSlug)?.hqSlug ?? null;
    const hqSlug = c.hqSlug ?? fromDashboard;
    return { id: c.id, name: c.name, accounts, dashboards: ds, hqSlug, dormant: c.dormant, suggestion: ambiguous ? null : candidates[0] ?? null, candidates, ambiguous };
  });
}

/**
 * Sets the HQ folder of a client: AlertClient.hqSlug and the hqSlug of every
 * dashboard on its accounts (their cached brief is dropped so the next report
 * reads the right folder). `null` detaches.
 */
export async function assignHqSlug(clientId: string, slug: string | null): Promise<{ dashboards: number }> {
  const c = await prisma.alertClient.findUnique({ where: { id: clientId }, select: { id: true, accountsJson: true } });
  if (!c) throw new Error("client introuvable");
  let accounts: Array<{ platform: string; accountId: string }> = [];
  try { accounts = JSON.parse(c.accountsJson); } catch { /* [] */ }
  const meta = accounts.filter((a) => a.platform === "meta").map((a) => a.accountId);
  const google = accounts.filter((a) => a.platform === "google").map((a) => a.accountId);
  await prisma.alertClient.update({ where: { id: clientId }, data: { hqSlug: slug } });
  const where = { OR: [...(meta.length ? [{ metaAccountId: { in: meta } }] : []), ...(google.length ? [{ googleCustomerId: { in: google } }] : [])] };
  if (!where.OR.length) return { dashboards: 0 };
  const r = await prisma.dashboard.updateMany({ where, data: { hqSlug: slug, hqContextMd: null, hqContextAt: null } });
  return { dashboards: r.count };
}
