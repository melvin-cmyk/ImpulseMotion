/**
 * What Mo takes from the client's HQ brief (the Markdown brief cached on the
 * Dashboard by lib/hq-client-context.ts, 7 days) without any new HQ call:
 * the brand lines a visual must respect, and the competitors named in the
 * market section. Pure, client-safe.
 */

const SECTION_RE = /^###\s+(.+)$/;

/** The sections of a brief (« ### Client » → its lines), headings folded. */
export function briefSections(brief: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const raw of brief.split(/\r?\n/)) {
    const m = raw.match(SECTION_RE);
    if (m) { current = fold(m[1]); if (!out.has(current)) out.set(current, []); continue; }
    if (current && raw.trim()) out.get(current)!.push(raw.trim());
  }
  return out;
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const pick = (sections: Map<string, string[]>, ...starts: string[]): string[] => { for (const [k, v] of sections) if (starts.some((s) => k.startsWith(s))) return v; return []; };

/**
 * The brand brief prepended to a generation prompt: who the client is, the
 * rules of the account, the personas (when confirmed), capped at `max`
 * characters. Empty when the brief carries none of that.
 */
export function brandBriefFromHq(brief: string | null | undefined, max = 900): string {
  if (!brief) return "";
  const s = briefSections(brief);
  const parts: string[] = [];
  const client = pick(s, "client");
  if (client.length) parts.push(`Marque : ${client.join(" ").replace(/^[-*]\s*/, "")}`);
  const rules = pick(s, "regles", "règles");
  if (rules.length) parts.push(`Règles de la marque : ${rules.map((l) => l.replace(/^[-*]\s*/, "")).join(" ; ")}`);
  const personas = pick(s, "personas");
  if (personas.length) parts.push(`Cibles : ${personas.slice(0, 3).map((l) => l.replace(/^[-*]\s*/, "")).join(" ; ")}`);
  const goals = pick(s, "objectifs");
  if (goals.length) parts.push(`Objectif : ${goals[0].replace(/^[-*]\s*/, "")}`);
  const text = parts.join("\n");
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text;
}

const NOT_BRANDS = new Set(["concurrents", "concurrent", "concurrence", "marché", "marche", "principaux", "directs", "indirects", "et", "ou", "les", "la", "le", "des", "de", "du", "en", "sur", "avec", "notamment", "comme", "etc", "autres", "leaders", "acteurs"]);

/**
 * The competitors a brief names (lines of the market section that mention
 * « concurren… », or a « Concurrents : A, B, C » line anywhere): 2 to 4
 * brand names, as written. Empty when the brief says nothing of it.
 */
export function competitorsFromBrief(brief: string | null | undefined, max = 4): string[] {
  if (!brief) return [];
  const lines = brief.split(/\r?\n/).map((l) => l.trim()).filter((l) => /concurren|comp[eé]tit/i.test(l));
  const found: string[] = [];
  for (const line of lines) {
    // « Concurrents : La Fourche, Aroma-Zone et Greenweez » → the part after the colon, split on commas / « et » / slashes.
    const after = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line.replace(/^.*?concurren\w*\s*(directs?|indirects?|principaux)?\s*/i, "");
    for (const raw of after.split(/\s*(?:,|;|\/|\bet\b|&|\(|\))\s*/i)) {
      const name = raw.replace(/^[-*•\s]+|[.\s]+$/g, "").replace(/\s+\([^)]*\)$/, "").trim();
      if (!name || name.length < 2 || name.length > 40) continue;
      const words = name.split(/\s+/);
      if (words.length > 4) continue;
      if (words.every((w) => NOT_BRANDS.has(w.toLowerCase()))) continue;
      // A brand starts with a capital, a digit, or is a known pattern (lowercase domain names are kept).
      if (!/^[A-Z0-9ÀÂÉÈÊÎÔÛ]|\.[a-z]{2,3}$/.test(name)) continue;
      if (!found.some((f) => f.toLowerCase() === name.toLowerCase())) found.push(name);
      if (found.length >= max) return found;
    }
  }
  return found;
}

/**
 * The prompt of « deux autres comme ça » written without the model: the
 * reference visuals (sent as images) carry the style; the words say what to
 * keep and what to change (the style asked: « en jaune », « plus sobre »).
 */
export function moreLikeThisPrompt(input: { clientName: string; names: string[]; notes?: string[]; style: string; n: number }): string {
  const refs = input.names.slice(0, 3).map((n) => `« ${n} »`).join(", ");
  const notes = (input.notes ?? []).filter(Boolean).slice(0, 2).join(" ; ");
  return [
    `Nouveau visuel publicitaire pour ${input.clientName}, dans l'esprit des créas de référence jointes${refs ? ` (${refs})` : ""} : même univers graphique, même cadrage, même palette, même niveau de finition.`,
    notes ? `Ce qui marche dans les références : ${notes}.` : "",
    input.style ? `Variante demandée : ${input.style}.` : `Propose une variante nouvelle (autre scène, autre angle ou autre accroche visuelle), fidèle au style.`,
    input.n > 1 ? `Chaque proposition doit être distincte des autres.` : "",
    "Rendu net et professionnel, format publicitaire. Aucun texte illisible ni inventé, pas de logo inventé, pas de filigrane.",
  ].filter(Boolean).join(" ");
}
