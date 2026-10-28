/**
 * Mo's fast path: navigation said out loud ("ouvre le cockpit de Naturalia",
 * "va sur l'analyse ads de LPEV", "montre-moi les rapports de Cours Legendre")
 * is understood in the browser and executed at once — no model call. Anything
 * that smells like a data question (metrics, periods, comparisons) is left to
 * the model, which answers with cards. Client-safe, pure.
 */

export interface IntentClient { id: string; name: string; dashboardId?: string | null; aliases?: string[] }
export interface NavIntent { path: string; say: string; label: string; clientName: string | null }

export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’']/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const NAV_VERBS = /\b(ouvre|ouvrir|ouvres|ouvrons|ouvrez|va sur|vas sur|va dans|aller sur|allons sur|allons dans|emmene moi|amene moi|montre moi|montre|affiche|afficher|lance|accede a|acceder a|direction|on va sur)\b/;
/** Words that make it a data question, not a navigation. */
const DATA_WORDS = /\b(cpa|cpl|cpm|cpc|ctr|roas|lead|leads|depense|depenses|budget|conversion|conversions|achat|achats|vente|ventes|impression|impressions|clic|clics|resultat|resultats|chiffre|chiffres|combien|compare|comparer|comparaison|evolution|hier|aujourd hui|semaine|mois|jour|jours|vendredi|lundi|mardi|mercredi|jeudi|samedi|dimanche|periode|depuis|entre|top|meilleur|meilleure|meilleurs|pire|baisse|hausse|tendance|poste|postees|postes|lancees|lancee|creees|creee|performance|performances|kpi|kpis|tableau de bord|courbe|graphique|note|resume)\b/;

interface Target { re: RegExp; label: string; path: (c: IntentClient | null) => string | null; root: string }
const TARGETS: Target[] = [
  { re: /\b(cockpit|cockpite|cokpit|cock pit|coque pit|copie|fiche client|fiche|hub|tout le client)\b/, label: "le cockpit", path: (c) => (c ? `/portfolio/${c.id}` : "/cockpit"), root: "/cockpit" },
  { re: /\b(analyse ads|analyse ad|analysade|analyse adds|analyse|analyses|creas? ads|ads)\b/, label: "l'Analyse Ads", path: (c) => (c ? `/analyse?client=${c.id}` : "/analyse"), root: "/analyse" },
  { re: /\b(creas?|creatives?|visuels|templates?|swipe)\b/, label: "les Créas", path: (c) => (c ? `/creas?client=${c.id}` : "/creas"), root: "/creas" },
  { re: /\b(dashboards?|dash|tableaux? de bord)\b/, label: "le dashboard", path: (c) => (c ? (c.dashboardId ? `/d/${c.dashboardId}` : `/d/${c.id}`) : "/dashboards"), root: "/dashboards" },
  { re: /\b(rapports?|reporting|report)\b/, label: "les rapports IA", path: (c) => (c ? `/reports?dashboardId=${c.dashboardId ?? c.id}` : "/reports"), root: "/reports" },
  { re: /\b(pilotage|pilote|modifs?|modifications?)\b/, label: "le pilotage", path: (c) => (c ? `/pilotage?dashboardId=${c.dashboardId ?? c.id}` : "/pilotage"), root: "/pilotage" },
  { re: /\b(alertes?|alerting)\b/, label: "les alertes", path: (c) => (c ? `/me/alerts?dashboardId=${c.dashboardId ?? c.id}` : "/me/alerts"), root: "/me/alerts" },
  { re: /\b(routines?|automatisations?)\b/, label: "les routines", path: (c) => (c ? `/routines?dashboardId=${c.dashboardId ?? c.id}` : "/routines"), root: "/routines" },
  { re: /\b(studio|generateur d images?)\b/, label: "le Studio", path: () => "/studio", root: "/studio" },
  { re: /\b(design|designs|figcraft|photocraft)\b/, label: "le Design", path: (c) => (c ? `/design?client=${c.dashboardId ?? c.id}` : "/design"), root: "/design" },
  { re: /\b(clients|portefeuille|portfolio|liste des clients)\b/, label: "la liste des clients", path: () => "/portfolio", root: "/portfolio" },
  { re: /\b(assistant|console|ai assistant|chat)\b/, label: "l'assistant IA", path: () => "/ai", root: "/ai" },
  { re: /\b(tableau|table|board|mon tableau|mo)\b/, label: "ton tableau Mo", path: () => "/mo", root: "/mo" },
  { re: /\b(quotas?)\b/, label: "les quotas", path: () => "/admin/quotas", root: "/admin/quotas" },
];

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** Edits tolerated between a spoken name and a client name, once spaces are removed. */
const compactTolerance = (len: number) => (len <= 7 ? 1 : len <= 11 ? 2 : 3);

/**
 * Speech recognisers split or glue words at will ("court Legendre", "cours le
 * jendin", "courtle Gendre"): compare without spaces, sliding over the
 * sentence, and return the smallest edit distance (or null when too far).
 */
function compactDistance(compactText: string, compactName: string): number | null {
  const n = compactName.length;
  if (n < 6 || compactText.length < n - 1) return null;
  const tol = compactTolerance(n);
  let best: number | null = null;
  for (const len of [n, n - 1, n + 1]) {
    if (len < 1) continue;
    for (let i = 0; i + len <= compactText.length; i++) {
      const d = levenshtein(compactText.slice(i, i + len), compactName);
      if (d <= tol && (best === null || d < best)) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

/** The client named in the text (exact, token-prefix, one typo, or a close match once spaces are ignored), or null when none / ambiguous. */
export function matchClientName(text: string, clients: IntentClient[]): IntentClient | null {
  const t = fold(text);
  const words = t.split(" ").filter(Boolean);
  const compactText = t.replace(/ /g, "");
  const best: { c: IntentClient; score: number }[] = [];
  for (const c of clients) {
    const names = [c.name, ...(c.aliases ?? [])].map(fold).filter(Boolean);
    let score = 0;
    for (const name of names) {
      if (!score) {
        const d = compactDistance(compactText, name.replace(/ /g, ""));
        if (d !== null) score = Math.max(score, 30 + name.length - d * 3);
      }
      if (name.length >= 3 && t.includes(name)) { score = Math.max(score, 100 + name.length); continue; }
      const toks = name.split(" ").filter((w) => w.length >= 3);
      if (!toks.length) continue;
      let hit = 0;
      for (const tok of toks) {
        if (words.some((w) => (w.length >= 4 && (tok.startsWith(w) || w.startsWith(tok))) || (tok.length >= 5 && w.length >= 5 && levenshtein(w, tok) <= (tok.length >= 8 ? 2 : 1)))) hit++;
      }
      if (hit === toks.length) score = Math.max(score, 50 + name.length);
      else if (hit && toks.length > 1 && hit >= Math.ceil(toks.length / 2) && toks.some((tok) => tok.length >= 5 && words.includes(tok))) score = Math.max(score, 20 + hit * 5);
    }
    if (score) best.push({ c, score });
  }
  if (!best.length) return null;
  best.sort((a, b) => b.score - a.score);
  if (best.length > 1 && best[0].score === best[1].score && best[0].c.id !== best[1].c.id) return null;
  return best[0].c;
}

/** The sentence without the client's name (as said, even misheard) so the page noun can be judged alone. */
function stripClientName(t: string, client: IntentClient): string {
  const names = [client.name, ...(client.aliases ?? [])].map(fold).filter(Boolean);
  let out = t;
  for (const name of names) if (name.length >= 3 && out.includes(name)) out = out.replace(name, " ");
  if (out === t) {
    // Fuzzy match: drop the words that resemble the name's tokens.
    const toks = names.flatMap((n) => n.split(" ")).filter((w) => w.length >= 3);
    out = t.split(" ").filter((w) => !toks.some((tok) => w.length >= 3 && (tok.startsWith(w) || w.startsWith(tok) || levenshtein(w, tok) <= 1))).join(" ");
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * A navigation intent, or null when the sentence is for the model.
 * Rules: a navigation verb, a page noun, no data word; "ouvre/va sur" are
 * unambiguous, "montre/affiche" need a short sentence.
 */
export function parseNavIntent(text: string, clients: IntentClient[]): NavIntent | null {
  const t = fold(text);
  if (!t || t.length > 140) return null;
  const verb = t.match(NAV_VERBS)?.[1];
  if (!verb) return null;
  if (DATA_WORDS.test(t)) return null;
  const client = matchClientName(t, clients);
  // Remove the client's name to judge the rest of the sentence.
  const rest = client ? stripClientName(t, client) : t;
  const target = TARGETS.find((x) => x.re.test(rest));
  if (!target) return null;
  const soft = /^(montre|montre moi|affiche|afficher|lance|direction)$/.test(verb);
  if (soft && rest.split(" ").filter(Boolean).length > 9) return null;
  const path = target.path(client);
  if (!path) return null;
  const say = client ? `J'ouvre ${target.label} de ${client.name}.` : `J'ouvre ${target.label}.`;
  return { path, say, label: target.label, clientName: client?.name ?? null };
}

// ── Quick path: the most frequent asks run without the model ─────────────────

export type QuickPeriod = "today" | "yesterday" | "this_week" | "last_week" | "last_7d" | "last_14d" | "last_30d" | "this_month" | "last_month";
export interface QuickIntent {
  kind: "creatives" | "metrics";
  client: IntentClient;
  args: Record<string, unknown>;
  /** What Mo says while the card lands. */
  say: string;
  periodLabel: string;
}

/** A period the person may pick when Mo asks for one. */
export interface QuickPeriodOption { period: QuickPeriod; label: string }

/**
 * A créas / chiffres ask with exactly one element missing: Mo asks for it
 * with chips instead of handing the sentence to the model. `draft` keeps the
 * sentence so the chosen chip completes it (see `completeQuickAsk`).
 */
export type QuickAsk =
  | { kind: "ask"; missing: "client"; question: string; candidates: IntentClient[]; draft: { what: "creatives" | "metrics"; text: string } }
  | { kind: "ask"; missing: "period"; question: string; candidates: QuickPeriodOption[]; draft: { what: "creatives" | "metrics"; text: string; client: IntentClient } };

export type QuickResult = QuickIntent | QuickAsk;

const PERIOD_WORDS: Array<[RegExp, QuickPeriod, string]> = [
  [/\b(aujourd hui|ce jour|today)\b/, "today", "aujourd'hui"],
  [/\bhier\b/, "yesterday", "hier"],
  [/\b(cette semaine|la semaine|semaine en cours)\b/, "this_week", "cette semaine"],
  [/\b(semaine derniere|la semaine passee|semaine passee|semaine d avant|semaine precedente)\b/, "last_week", "la semaine dernière"],
  [/\b(7|sept) derniers jours\b/, "last_7d", "sur 7 jours"],
  [/\b(14|quatorze|15|quinze) derniers jours\b/, "last_14d", "sur 14 jours"],
  [/\b(30|trente) derniers jours\b/, "last_30d", "sur 30 jours"],
  [/\b(ce mois|ce mois ci|le mois en cours)\b/, "this_month", "ce mois-ci"],
  [/\b(mois dernier|le mois passe|mois precedent)\b/, "last_month", "le mois dernier"],
];
const CREA_WORDS = /\b(creas?|creatives?|visuels?|pubs?|publicites?|annonces?|ads)\b/;
const SHOW_VERBS = /\b(affiche|montre|sors|sort|donne|liste|voir|vois|mets|met|ouvre|regarde|recupere|ressors|balance|fais voir|je veux voir|je veux|il me faut)\b/;
const METRIC_WORDS = /\b(cpa|cpl|cpm|cpc|ctr|roas|leads?|conversions?|achats?|ventes?|depenses?|chiffres?|resultats?|performances?|perf|kpis?|ca donne quoi|comment ca va|comment ca se passe|ou en est|bilan|point)\b/;
const NOT_QUICK = /\b(compare|comparer|comparaison|versus|vs|pourquoi|explique|analyse|analyser|recommand|conseil|avis|penses|genere|generer|cree|creer|publie|publier|variante|modifie|change|ajoute|retire|supprime|enleve|en direct|google|tiktok|ga4|audience|ciblage|placement|enchere|budget)\b/;

/** The periods offered when Mo asks for one. */
export const PERIOD_OPTIONS: QuickPeriodOption[] = [
  { period: "today", label: "aujourd'hui" },
  { period: "yesterday", label: "hier" },
  { period: "this_week", label: "cette semaine" },
  { period: "last_week", label: "la semaine dernière" },
  { period: "this_month", label: "ce mois-ci" },
  { period: "last_30d", label: "sur 30 jours" },
];

/**
 * « Affiche-moi les créas de cette semaine sur Cours Legendre », « les 10
 * dernières créas Meta de LPEV », « le CPA de Naturalia cette semaine » : a
 * named client + a thing to show (+ a period, else the last 7 days) → the
 * tool is run at once by the app (no model), Mo says a short sentence.
 * « créas cette semaine » with no client named → an `ask` (chips of clients).
 * Null for anything else (the model takes over).
 */
export function parseQuickIntent(text: string, clients: IntentClient[]): QuickResult | null {
  const t = fold(text);
  if (!t || t.length > 160 || NOT_QUICK.test(t)) return null;
  const client = matchClientName(t, clients);
  const rest = client ? t.replace(fold(client.name), " ").replace(/\s+/g, " ") : t;
  const period = PERIOD_WORDS.find(([re]) => re.test(rest));
  const latest = rest.match(/\b(\d{1,2})\s+dernieres?\b/);
  const top = rest.match(/\b(top|meilleures?|plus (?:depense|performantes?|rentables?)|qui (?:ont|a) le plus depense|qui marchent? le mieux)\b/);
  const worst = /\b(pires?|moins bonnes?|qui marchent? le moins)\b/.test(rest);
  const launched = /\b(lancees?|postees?|mises? en ligne|sorties?|nouvelles?)\b/.test(rest);
  const n = rest.match(/\b(\d{1,2})\b/);
  const platform = /\bmeta|facebook|insta(gram)?\b/.test(rest) ? "meta" : /\bgoogle\b/.test(rest) ? "google" : /\btiktok\b/.test(rest) ? "tiktok" : undefined;
  const wantsCreatives = CREA_WORDS.test(rest) && (SHOW_VERBS.test(rest) || latest || top || period || worst || (client && rest.split(" ").filter(Boolean).length <= 4));
  const wantsMetrics = !CREA_WORDS.test(rest) && METRIC_WORDS.test(rest);

  if (!client) {
    // One thing missing (the client) and the rest is clear: ask with chips. Too vague (no period, no shape) → the model.
    if (!clients.length) return null;
    const shaped = !!(period || latest || top || worst);
    if (wantsCreatives && shaped) return { kind: "ask", missing: "client", question: "Pour quel client ?", candidates: sortedClients(clients), draft: { what: "creatives", text } };
    if (wantsMetrics && period) return { kind: "ask", missing: "client", question: "Pour quel client ?", candidates: sortedClients(clients), draft: { what: "metrics", text } };
    return null;
  }

  if (wantsCreatives) {
    const args: Record<string, unknown> = { client: client.id, ...(platform ? { platform } : {}) };
    let label = period ? period[2] : "sur 7 jours";
    if (period) args.period = period[1];
    else if (!latest && !top && !worst) args.period = "last_7d";
    if (latest) { args.sort = "launch"; args.order = "desc"; args.limit = Math.min(24, Math.max(1, Number(latest[1]))); label = `les ${latest[1]} dernières`; }
    else if (n) args.limit = Math.min(24, Math.max(1, Number(n[1])));
    if (top) { args.sort = /cpa|cpl/.test(rest) ? "cpa" : /ctr/.test(rest) ? "ctr" : /roas/.test(rest) ? "roas" : "spend"; args.order = /cpa|cpl/.test(rest) ? "asc" : "desc"; }
    if (worst) { args.sort = /cpa|cpl/.test(rest) ? "cpa" : "ctr"; args.order = /cpa|cpl/.test(rest) ? "desc" : "asc"; }
    if (launched && period) args.launched_in_period = true;
    const say = latest ? `Voilà les ${latest[1]} dernières créas de ${client.name}.` : top ? `Voilà les créas de ${client.name} qui ${/cpa|cpl/.test(rest) ? "ont le meilleur coût" : "ont le plus dépensé"} ${label}.` : `Voilà les créas de ${client.name} ${label}.`;
    return { kind: "creatives", client, args, say, periodLabel: label };
  }
  if (wantsMetrics) {
    // No period said: the last 7 days (no question asked).
    const by = /\bpar campagne\b/.test(rest) ? "campaign" : /\bpar (ensemble|adset|ad set)\b/.test(rest) ? "adset" : /\bpar format\b/.test(rest) ? "format" : undefined;
    const args: Record<string, unknown> = { client: client.id, period: period ? period[1] : "last_7d", ...(by ? { by } : {}), ...(platform ? { platform } : {}) };
    const label = period ? period[2] : "sur 7 jours";
    return { kind: "metrics", client, args, say: `Voilà les chiffres de ${client.name} ${label}${by ? `, par ${by === "campaign" ? "campagne" : by === "adset" ? "ensemble" : "format"}` : ""}.`, periodLabel: label };
  }
  return null;
}

const sortedClients = (clients: IntentClient[]) => [...clients].sort((a, b) => a.name.localeCompare(b.name, "fr"));

/** The sentence completed with the chip picked, ready for the quick path again. */
export function completeQuickAsk(ask: QuickAsk, choice: IntentClient | QuickPeriodOption): string {
  const base = ask.draft.text.trim().replace(/[\s?.!…]+$/, "");
  if (ask.missing === "client") return `${base} pour ${(choice as IntentClient).name}`;
  return `${base} ${(choice as QuickPeriodOption).label}`;
}

/**
 * Clients « of the day » first (those already named on a card of the board,
 * most recent first), then the rest alphabetically — for the chips.
 */
export function orderClientCandidates(candidates: IntentClient[], cards: Array<{ title: string; subtitle?: string; at?: string }>): IntentClient[] {
  const seen = new Map<string, number>();
  for (const c of cards) {
    const m = matchClientName(`${c.title} ${c.subtitle ?? ""}`, candidates);
    if (!m) continue;
    const t = c.at ? new Date(c.at).getTime() || 0 : 0;
    seen.set(m.id, Math.max(seen.get(m.id) ?? 0, t));
  }
  const today = candidates.filter((c) => seen.has(c.id)).sort((a, b) => (seen.get(b.id) ?? 0) - (seen.get(a.id) ?? 0));
  const rest = candidates.filter((c) => !seen.has(c.id)).sort((a, b) => a.name.localeCompare(b.name, "fr"));
  return [...today, ...rest];
}

/** A short title for the card about to land (« Créas Cours Legendre · cette semaine »), from the ask. */
export function ghostTitle(text: string, quick: QuickResult | null): string {
  if (quick && quick.kind === "creatives") return `Créas ${quick.client.name} · ${quick.periodLabel}`;
  if (quick && quick.kind === "metrics") return `Chiffres ${quick.client.name} · ${quick.periodLabel}`;
  const clean = text.replace(/\s+/g, " ").trim().replace(/^(hello|salut|bonjour|hey|ok)\s+mo[,\s]*/i, "").replace(/^mo[,\s]+/i, "");
  const short = clean.length > 60 ? clean.slice(0, 59).trimEnd() + "…" : clean;
  return short ? short.charAt(0).toUpperCase() + short.slice(1) : "En cours";
}
