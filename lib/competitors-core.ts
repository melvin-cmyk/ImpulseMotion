/**
 * Competitors of a client — the pure part (client-safe, tested in
 * lib/__tests__/competitors.test.ts). The server part is lib/competitors.ts.
 *
 * A client's list merges, in this order, without duplicates:
 *   saved      names the consultants added (AppSetting « competitors:<clientId> »)
 *   hq         names the client's HQ brief gives (lib/mo/brief.ts competitorsFromBrief)
 *   suggested  names the AI proposed when the two above give fewer than 3
 *              (AppSetting « competitors-ai:<clientId> », 30 days)
 * A name the consultant removed is hidden whatever its origin (« removed »).
 */

export type CompetitorOrigin = "saved" | "hq" | "suggested";
export interface Competitor { name: string; origin: CompetitorOrigin }

/** What the consultants keep per client. */
export interface CompetitorSetting { saved: string[]; removed: string[] }
/** The AI's proposal, cached. */
export interface CompetitorSuggestions { names: string[]; at: string }

export const COMPETITORS_KEY = (clientId: string) => `competitors:${clientId}`;
export const SUGGESTIONS_KEY = (clientId: string) => `competitors-ai:${clientId}`;
export const SUGGESTIONS_TTL_MS = 30 * 86_400_000;
/** Below this many saved + HQ names, the AI is asked for suggestions. */
export const MIN_CONFIRMED = 3;
export const MAX_COMPETITORS = 12;

export const ORIGIN_LABEL: Record<CompetitorOrigin, string> = { saved: "ajouté", hq: "HQ", suggested: "suggéré par l'IA" };

/** « la  fourche » → « la fourche » (spaces, quotes, bullets trimmed), at most 60 characters; empty when unusable. */
export function cleanBrand(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw.replace(/[«»"“”]/g, "").replace(/^[-*•\d.)\s]+/, "").replace(/\s+/g, " ").replace(/[\s.;,:!?]+$/, "").trim();
  return s.length >= 2 && s.length <= 60 ? s : "";
}

/** The comparison key of a brand: accents, case and punctuation folded (« Aroma-Zone » = « aroma zone »). */
export function brandKey(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function parseSetting(json: string | null | undefined): CompetitorSetting {
  try {
    const v = JSON.parse(json ?? "{}") as Partial<CompetitorSetting>;
    const list = (x: unknown) => (Array.isArray(x) ? x.map(cleanBrand).filter(Boolean) : []);
    return { saved: dedupe(list(v.saved)), removed: dedupe(list(v.removed)) };
  } catch { return { saved: [], removed: [] }; }
}

export function parseSuggestionsSetting(json: string | null | undefined): CompetitorSuggestions | null {
  try {
    const v = JSON.parse(json ?? "null") as Partial<CompetitorSuggestions> | null;
    if (!v || !Array.isArray(v.names) || typeof v.at !== "string") return null;
    return { names: dedupe(v.names.map(cleanBrand).filter(Boolean)), at: v.at };
  } catch { return null; }
}

export const suggestionsFresh = (s: CompetitorSuggestions | null, now = Date.now()): boolean => !!s && now - Date.parse(s.at) < SUGGESTIONS_TTL_MS;

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((n) => { const k = brandKey(n); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

/** The setting after the consultant added a name (no longer hidden, saved first). */
export function addCompetitor(s: CompetitorSetting, raw: string): CompetitorSetting {
  const name = cleanBrand(raw);
  if (!name) return s;
  const k = brandKey(name);
  return { saved: [name, ...s.saved.filter((n) => brandKey(n) !== k)].slice(0, MAX_COMPETITORS), removed: s.removed.filter((n) => brandKey(n) !== k) };
}

/** The setting after the consultant removed a name: out of the saved ones, and hidden (an HQ or AI name stays hidden). */
export function removeCompetitor(s: CompetitorSetting, raw: string): CompetitorSetting {
  const name = cleanBrand(raw);
  if (!name) return s;
  const k = brandKey(name);
  return { saved: s.saved.filter((n) => brandKey(n) !== k), removed: [name, ...s.removed.filter((n) => brandKey(n) !== k)].slice(0, 40) };
}

/** The merged list: saved, then HQ, then suggested; the hidden names and the client itself left out. */
export function mergeCompetitors(input: { setting: CompetitorSetting; hq: string[]; suggested: string[]; clientName?: string | null }, max = MAX_COMPETITORS): Competitor[] {
  const out: Competitor[] = [];
  const seen = new Set<string>(input.setting.removed.map(brandKey));
  const self = input.clientName ? brandKey(input.clientName) : "";
  const push = (raw: string, origin: CompetitorOrigin) => {
    const name = cleanBrand(raw);
    const k = name ? brandKey(name) : "";
    if (!k || seen.has(k) || (self && (k === self || k.replace(/ /g, "") === self.replace(/ /g, "")))) return;
    seen.add(k);
    out.push({ name, origin });
  };
  for (const n of input.setting.saved) push(n, "saved");
  for (const n of input.hq) push(n, "hq");
  for (const n of input.suggested) push(n, "suggested");
  return out.slice(0, max);
}

/** True when the names confirmed by a person (saved or HQ) are too few: the AI is asked to suggest more. */
export const needsSuggestions = (list: Competitor[]): boolean => list.filter((c) => c.origin !== "suggested").length < MIN_CONFIRMED;

/** The landing-page domains of the client's ads, most frequent first (www. dropped, at most `max`). */
export function landingDomains(urls: Array<string | null | undefined>, max = 5): string[] {
  const count = new Map<string, number>();
  for (const u of urls) {
    if (!u) continue;
    try {
      const host = new URL(u).hostname.replace(/^www\./, "").toLowerCase();
      if (!host || /(^|\.)(facebook|fb|instagram|google|bit\.ly|linktr)\./.test(host + ".")) continue;
      count.set(host, (count.get(host) ?? 0) + 1);
    } catch { /* not a URL */ }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([h]) => h);
}

export const SUGGEST_SYSTEM = `Tu es planneur stratégique dans une agence de publicité digitale française. On te donne un client (son nom, ses sites, des textes de ses publicités, parfois son brief). Tu cites ses CONCURRENTS DIRECTS : des marques réelles qui vendent la même chose au même public en France, et qui font probablement de la publicité sur Facebook / Instagram.
Réponds UNIQUEMENT par un objet JSON, sans texte autour : {"competitors": ["Marque 1", "Marque 2", "Marque 3", "Marque 4", "Marque 5"]}
Règles : exactement 5 noms de marques tels qu'ils s'écrivent (pas de description, pas d'URL), jamais le client lui-même, pas de places de marché génériques (Amazon, Cdiscount…) sauf si c'est vraiment le concurrent principal. Si tu n'es pas sûr, choisis les acteurs les plus connus du même secteur.`;

/** The user message of the suggestion call (bounded: a few hundred words). */
export function suggestionPrompt(input: { clientName: string; domains: string[]; adTexts: string[]; brief?: string | null; known?: string[] }): string {
  const texts = input.adTexts.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t.length > 10);
  const uniq = [...new Set(texts)].slice(0, 6).map((t) => `- ${t.slice(0, 220)}`);
  return [
    `Client : ${input.clientName}`,
    input.domains.length ? `Sites de destination de ses pubs : ${input.domains.join(", ")}` : "",
    uniq.length ? `Textes de ses publicités récentes :\n${uniq.join("\n")}` : "",
    input.brief?.trim() ? `Brief du client (extrait) :\n${input.brief.trim().slice(0, 900)}` : "",
    input.known?.length ? `Déjà connus (ne les répète pas) : ${input.known.join(", ")}` : "",
    "Quels sont ses 5 concurrents directs ?",
  ].filter(Boolean).join("\n\n");
}

/** The names of the model's answer ({"competitors": [...]}, a bare list, or one name per line), cleaned, at most 5. */
export function parseSuggestions(text: string, clientName?: string | null): string[] {
  let names: unknown[] = [];
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.search(/[[{]/);
  if (start >= 0) {
    try {
      const v = JSON.parse(cleaned.slice(start, Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]")) + 1)) as unknown;
      names = Array.isArray(v) ? v : v && typeof v === "object" && Array.isArray((v as { competitors?: unknown }).competitors) ? (v as { competitors: unknown[] }).competitors : [];
    } catch { names = []; }
  }
  if (!names.length) names = cleaned.split(/\r?\n/);
  const self = clientName ? brandKey(clientName) : "";
  return dedupe(names.map((n) => cleanBrand(typeof n === "object" && n && "name" in n ? (n as { name: unknown }).name : n)).filter((n) => n && n.split(" ").length <= 5 && brandKey(n) !== self)).slice(0, 5);
}

/**
 * The chips Mo offers when nobody named the client's competitors: one per
 * suggested brand, worded so that the quick path recognises it
 * (lib/mo/intents.ts « pubs du concurrent X pour <client> »), ≤ 60 characters.
 */
export function competitorChips(names: string[], clientName: string, max = 4): string[] {
  // A chip cut short would search another brand: a name that does not fit is left out (the consultant can type it).
  return names.map((n) => {
    const full = `Pubs du concurrent ${n} pour ${clientName}`;
    const short = `Montre les pubs de ${n}`;
    return full.length <= 60 ? full : short.length <= 60 ? short : "";
  }).filter(Boolean).slice(0, max);
}
