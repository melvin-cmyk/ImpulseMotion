/**
 * Mo's fast path: navigation said out loud ("ouvre le cockpit de Naturalia",
 * "va sur l'analyse ads de LPEV", "montre-moi les rapports de Cours Legendre")
 * is understood in the browser and executed at once — no model call. Anything
 * that smells like a data question (metrics, periods, comparisons) is left to
 * the model, which answers with cards. Client-safe, pure.
 */

export interface IntentClient { id: string; name: string; dashboardId?: string | null; aliases?: string[]; /** Other registry ids of the same client (lib/clients/registry.ts aliasIds). */ aliasIds?: string[] }
export interface NavIntent { path: string; say: string; label: string; clientName: string | null }

export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[’']/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Short names the team says or types for clients, beside the registry names:
 * « CL » for Cours Legendre, « natu » for Naturalia… Key = the alias as said
 * (any case, accents ignored), value = the start of the client's registry name
 * (folded: lower case, no accents). TO EXTEND: add a line; both the browser and
 * the server read this table through `withClientAliases`, nothing else to do.
 * An alias of 1-3 letters only matches as a whole word (« cl »), longer ones
 * like any other name. Ids merged by the registry (`aliasIds`) are carried by
 * `withClientAliases` too, so a card tagged with an old id still finds its client.
 */
export const CLIENT_ALIASES: Record<string, string> = {
  "cl": "cours legendre",
  "legendre": "cours legendre",
  "natu": "naturalia",
  "lbv": "le barth",
  "sev": "saveurs",
  "la petite epicerie verte": "lpev",
};

/** The clients with their spoken aliases (table above) and their merged ids, ready for the matchers. */
export function withClientAliases<C extends IntentClient>(clients: C[]): C[] {
  return clients.map((c) => {
    const key = fold(c.name);
    const extra = Object.entries(CLIENT_ALIASES).filter(([, name]) => key === name || key.startsWith(name + " ") || key.startsWith(name)).map(([alias]) => alias);
    const aliases = [...new Set([...(c.aliases ?? []), ...extra])];
    return aliases.length ? { ...c, aliases } : c;
  });
}

/** True when `id` is the client's id or one of its merged ids. */
export const isClientId = (c: Pick<IntentClient, "id" | "aliasIds">, id: string | null | undefined): boolean => !!id && (c.id === id || (c.aliasIds ?? []).includes(id));

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
  // The Studio créa is now the « Générer » tab of the Créas (per client).
  { re: /\b(studio|generateur d images?)\b/, label: "la génération de créas", path: (c) => (c ? `/creas?client=${c.id}&tab=generer` : "/creas?tab=generer"), root: "/creas" },
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
      // A short alias (« cl ») counts only as a whole word.
      if (name.length <= 3) { if (words.includes(name)) score = Math.max(score, 90); continue; }
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

// ── Follow-ups on the card at hand (no client named: the fresh or selected creatives card) ──

/** « Mets les chiffres dessous » → the figures under the visuals of the card; « garde / coupe celle-là » → a verdict on one of them. */
export type FollowUpTarget = { which: "this" } | { which: "index"; index: number } | { which: "all" } | { which: "last"; count: number };
export type FollowUpIntent =
  | { kind: "creative_metrics"; period?: QuickPeriod; say: string }
  | { kind: "verdict"; verdict: "keep" | "cut"; target: FollowUpTarget; say: string }
  /** « Publie la première » : a publication prepared for one visual of the card (confirmed by a click, never sent here). */
  | { kind: "publish"; target: FollowUpTarget; say: string }
  /** « Mets ça dans un Google Sheet », « exporte en tableur » : the card at hand (table, KPI, creatives) exported as a Google Sheet. */
  | { kind: "sheet"; say: string };

const METRICS_UNDER = /\b(chiffres?|metrics?|metriques?|resultats?|perfs?|performances?|stats?|cpa|cpl|roas|ctr)\b/;
const UNDER_WORDS = /\b(dessous|en dessous|sous (chaque|les|ces|la|le|tous les)|sur (chaque|les|ces) (visuel|crea|image|pub)|de (chaque|ces|les) (visuel|crea|pub))/;
const KEEP_VERBS = /\b(garde|gardes|garder|gardons|on garde|je garde|conserve|conserver|valide|valider|retiens|ok pour|top pour|j aime)\b/;
const CUT_VERBS = /\b(coupe|coupes|couper|coupons|on coupe|je coupe|vire|virer|jette|jeter|elimine|eliminer|rejette|rejeter|pas celle|non pour|bof|stoppe|arrete)\b/;
const ORDINALS: Array<[RegExp, number]> = [
  [/\b(premiere?|1(?:ere?|re)?)\b/, 0], [/\b(deuxieme|seconde?|2(?:e|eme)?)\b/, 1], [/\b(troisieme|3(?:e|eme)?)\b/, 2], [/\b(quatrieme|4(?:e|eme)?)\b/, 3],
  [/\b(cinquieme|5(?:e|eme)?)\b/, 4], [/\b(sixieme|6(?:e|eme)?)\b/, 5], [/\b(septieme|7(?:e|eme)?)\b/, 6], [/\b(huitieme|8(?:e|eme)?)\b/, 7],
  [/\b(neuvieme|9(?:e|eme)?)\b/, 8], [/\b(dixieme|10(?:e|eme)?)\b/, 9], [/\b(onzieme|11(?:e|eme)?)\b/, 10], [/\b(douzieme|12(?:e|eme)?)\b/, 11],
];
const THIS_ONE = /\b(celle (la|ci)|celui (la|ci)|ca|cette (crea|pub|image|visuel)|ce visuel|cette la|la (la|ci))\b|\b(garde|coupe|vire|conserve|valide|jette|publie|poste) (la|le)\b/;
const ALL_ONES = /\b(toutes?|tous|les deux|le lot|tout)\b/;
/** « les deux dernières », « la dernière » → the last N visuals of the card. */
const LAST_ONES = /\b(?:les |la )?(deux|trois|quatre|2|3|4)?\s*dernieres?\b/;
const PUBLISH_VERBS = /\b(publie|publies|publier|publions|poste|postes|poster|mets? en ligne|mettre en ligne|envoie en pub|lance la pub|diffuse|diffuser)\b/;
const SMALL_NUMBERS: Record<string, number> = { un: 1, une: 1, "1": 1, deux: 2, "2": 2, trois: 3, "3": 3, quatre: 4, "4": 4 };
/** Where the person wants the rows: a spreadsheet, however it is called. */
const SHEET_WORDS = /\b(google ?sheets?|g ?sheets?|sheets?|spreadsheets?|tableur|excel|feuille de calcul|xlsx?|csv)\b/;
const SHEET_VERBS = /\b(mets?|mettre|met|exporte|exporter|export|exportes|envoie|envoyer|envoies|sors|sortir|passe|passer|bascule|basculer|colle|coller|copie|copier|balance|balancer|range|ranger|pose|poser|fais|fait|faire|genere|generer|cree|creer|transforme|convertis|convertir)\b/;

/** Which visual(s) of the card a sentence points at (ordinal, last N, all, this one), or null. */
function followUpTarget(t: string, words: number): FollowUpTarget | null {
  const last = t.match(LAST_ONES);
  if (last) return { which: "last", count: last[1] ? SMALL_NUMBERS[last[1]] ?? 1 : 1 };
  const ord = ORDINALS.find(([re]) => re.test(t));
  if (ord) return { which: "index", index: ord[1] };
  if (ALL_ONES.test(t)) return { which: "all" };
  if (THIS_ONE.test(t) || words <= 2) return { which: "this" };
  return null;
}

/**
 * A follow-up said over a creatives card: the figures under its visuals, or
 * a verdict on one of them. Null when the sentence is anything else (a client
 * name, a period alone, a question).
 */
export function parseFollowUpIntent(text: string): FollowUpIntent | null {
  const t = fold(text);
  if (!t || t.length > 120) return null;
  const words = t.split(" ").filter(Boolean).length;
  // « mets ça dans un google sheet », « exporte en tableur », « envoie ce tableau dans sheets », « google sheet ? » : the card at hand becomes a Sheet.
  if (SHEET_WORDS.test(t) && (SHEET_VERBS.test(t) || words <= 4) && !/\b(ouvre|ouvrir|lis|lire|montre|affiche|importe|importer|depuis|a partir)\b/.test(t) && !/\b(de|pour|chez)\s+[a-z]{3,}\s+(cette|ce|la|le|sur|du|des|dans)\b/.test(t) && !/\b(compare|pourquoi|explique)\b/.test(t)) {
    return { kind: "sheet", say: "Je l'envoie dans Google Sheets." };
  }
  // « mets les chiffres sous chaque créa », « les chiffres dessous », « chiffres ? »
  if (METRICS_UNDER.test(t) && (UNDER_WORDS.test(t) || /\b(mets?|mettre|ajoute|affiche|montre)\b/.test(t) || words <= 3) && !/\b(de|pour|chez)\s+[a-z]{3,}\s+(cette|ce|la|le|sur|du|des)\b/.test(t) && !/\b(compare|pourquoi|explique)\b/.test(t)) {
    const period = PERIOD_WORDS.find(([re]) => re.test(t));
    return { kind: "creative_metrics", ...(period ? { period: period[1] } : {}), say: "Je mets les chiffres sous les visuels." };
  }
  // « publie la première », « poste celle-là » : a publication to prepare (the card « À publier » asks for the click).
  if (PUBLISH_VERBS.test(t) && !KEEP_VERBS.test(t) && !CUT_VERBS.test(t) && words <= 8) {
    const target = followUpTarget(t, words);
    if (target && target.which !== "all") return { kind: "publish", target, say: "Je prépare la publication." };
    return null;
  }
  const keep = KEEP_VERBS.test(t), cut = CUT_VERBS.test(t);
  if (keep === cut) return null;
  const verdict = keep ? "keep" as const : "cut" as const;
  const target = followUpTarget(t, words);
  if (!target) return null;
  const many = target.which === "all" || (target.which === "last" && target.count > 1);
  const say = verdict === "keep" ? (target.which === "all" ? "Je garde tout." : many ? "Je les garde." : "Je la garde.") : (target.which === "all" ? "Je coupe tout." : many ? "Je les coupe." : "Je la coupe.");
  return { kind: "verdict", verdict, target, say };
}

/** The indexes of a card's items a target points at (`hot` = the visual under the pointer, `count` = items on the card). */
export function targetIndexes(target: FollowUpTarget, count: number, hot: number | null): number[] {
  if (count <= 0) return [];
  switch (target.which) {
    case "all": return Array.from({ length: count }, (_, i) => i);
    case "index": return target.index < count ? [target.index] : [];
    case "last": return Array.from({ length: Math.min(target.count, count) }, (_, i) => count - 1 - i).reverse();
    case "this": return hot !== null && hot < count ? [hot] : count === 1 ? [0] : [];
  }
}

// ── Follow-ups that need the server (card at hand + warehouse / generation / Ad Library), still without the model ──

export type QuickFollowUp =
  /** « Deux autres comme ça (en jaune) » : new visuals inspired by the fresh / selected creatives card. */
  | { kind: "more_like_this"; n: number; style: string; say: string }
  /** « Compare avec la semaine d'avant » : the figures of the named period beside the KPI card at hand. */
  | { kind: "compare"; period: QuickPeriod | "previous"; periodLabel: string; client: IntentClient | null; say: string }
  /** « Montre les pubs de La Fourche », « les concurrents de Naturalia » : the Meta Ad Library (brands named, or the client's known competitors). */
  | { kind: "competitor_ads"; brands: string[]; client: IntentClient | null; say: string };

const MAKE_VERBS = /\b(cree|crees|creer|creons|fais|fait|faire|faisons|genere|generes|generer|generons|propose|proposes|refais|refaire|sors|produis|ponds|imagine|decline|declines|decliner|encore|il m en faut|j en veux|je veux|donne)\b/;
const LIKE_THIS = /\b(comme ca|comme celle (la|ci)|comme celles (la|ci)|dans le meme esprit|du meme genre|dans le meme style|du meme style|similaires?|pareils?|pareilles?|variantes?|declinaisons?|la meme|les memes|dans cette veine|sur ce modele|sur cette base|a partir de (ca|celle (la|ci)|celles (la|ci))|qui font ca|comme (la|les) (premiere|deuxieme|derniere|precedente)s?)\b/;
const COUNT_WORDS = /\b(un|une|deux|trois|quatre|1|2|3|4|d autres|des autres|autres?|plusieurs)\b/;
const COMPARE_WORDS = /\b(compare|compares|comparer|comparons|comparaison|versus|vs|par rapport a|par rapport au|et (la |le )?(semaine|mois) d avant|c etait comment|face a)\b/;
const PREVIOUS_WORDS = /\b(periode d avant|periode precedente|d avant|precedente?|avant)\b/;
const BRAND_ADS = /\b(pubs?|publicites?|annonces?|ads|campagnes?)\s+(?:de|du|des|d)\s+(.+)$/;
const COMPETITORS_OF = /\b(?:concurrents?|concurrence|competiteurs?|competition)\s+(?:de|du|des|d|chez|pour)\s+(.+)$/;
const EXTRA_PERIODS: Array<[RegExp, QuickPeriod, string]> = [[/\b(mois d avant|mois precedent)\b/, "last_month", "le mois dernier"], [/\b(semaine d avant|semaine precedente)\b/, "last_week", "la semaine dernière"]];

/**
 * A follow-up the server resolves against the card at hand, without the
 * model: more visuals like these, a comparison with another period, the ads
 * of a brand or of a client's competitors. Null for anything else.
 */
export function parseFollowUpQuick(text: string, clients: IntentClient[]): QuickFollowUp | null {
  const t = fold(text);
  if (!t || t.length > 140) return null;
  const words = t.split(" ").filter(Boolean);

  // Comparison with another period (figures only: a creatives comparison is the model's).
  if (COMPARE_WORDS.test(t) && !CREA_WORDS.test(t) && !/\b(pourquoi|explique|google|tiktok)\b/.test(t)) {
    const client = matchClientName(t, clients);
    const period = [...EXTRA_PERIODS, ...PERIOD_WORDS].find(([re]) => re.test(t));
    if (period) return { kind: "compare", period: period[1], periodLabel: period[2], client, say: `Je compare avec ${period[2]}.` };
    if (PREVIOUS_WORDS.test(t) || words.length <= 3) return { kind: "compare", period: "previous", periodLabel: "la période d'avant", client, say: "Je compare avec la période d'avant." };
    return null;
  }

  // More visuals like the ones on the card.
  const makes = MAKE_VERBS.test(t);
  const like = LIKE_THIS.test(t);
  const count = t.match(COUNT_WORDS);
  if ((like && (makes || count)) || (makes && count && /\bautres?\b/.test(t))) {
    if (/\b(chiffres?|metrics?|rapport|tableau)\b/.test(t)) return null;
    const num = count ? SMALL_NUMBERS[count[1]] : undefined;
    const n = Math.min(4, Math.max(1, num ?? (/\b(une|un|variante|la meme)\b/.test(t) ? 1 : 2)));
    // What is left once the verb, the count and « comme ça » are removed is the style asked (« en jaune », « plus sobre »).
    const style = t.replace(new RegExp(MAKE_VERBS.source, "g"), " ").replace(new RegExp(LIKE_THIS.source, "g"), " ").replace(new RegExp(COUNT_WORDS.source, "g"), " ").replace(/\b(m en|moi|nous en|s il te plait|stp|mo|hello|salut|ok|ca|celle (la|ci)|celles (la|ci)|qui font)\b/g, " ").replace(/\s+/g, " ").trim();
    return { kind: "more_like_this", n, style: style.length >= 3 ? style : "", say: n === 1 ? "Je prépare une variante, trente secondes." : `Je prépare ${n === 2 ? "deux" : n === 3 ? "trois" : "quatre"} visuels, trente secondes.` };
  }

  // The ads of a brand (Ad Library) or the competitors of a client.
  const comp = t.match(COMPETITORS_OF);
  if (comp) {
    const client = matchClientName(comp[1], clients);
    if (client) return { kind: "competitor_ads", brands: [], client, say: `Je cherche les concurrents de ${client.name} dans la bibliothèque Meta.` };
    const brands = splitBrands(text, comp[1]);
    return brands.length ? { kind: "competitor_ads", brands, client: null, say: `Je cherche les pubs de ${brands.join(" et ")}.` } : null;
  }
  const ads = t.match(BRAND_ADS);
  if (ads && /\b(montre|affiche|cherche|regarde|sors|voir|vois|trouve|donne|liste|fais voir|je veux|il me faut|ouvre|quelles?)\b/.test(t)) {
    const brands = splitBrands(text, ads[2]);
    if (!brands.length) return null;
    if (matchClientName(brands.join(" "), clients)) return null; // a client's own ads: the warehouse (parseQuickIntent)
    return { kind: "competitor_ads", brands, client: matchClientName(t.replace(ads[2], " "), clients), say: `Je cherche les pubs de ${brands.join(" et ")} dans la bibliothèque Meta, quinze secondes.` };
  }
  return null;
}

/** The brand names in the tail of a sentence, with the case the person typed (« La Fourche et Aroma-Zone » → two brands). */
export function splitBrands(original: string, foldedTail: string): string[] {
  const tail = foldedTail.replace(/\b(en ce moment|actuellement|aujourd hui|sur meta|sur facebook|sur insta(gram)?|dans la bibliotheque( meta| publicitaire)?|s il te plait|stp)\b/g, " ").replace(/\s+/g, " ").trim();
  if (!tail) return [];
  // Find the tail in the original sentence to keep the case (« Aroma-Zone » folds to two words: words are aligned on their folded tokens); fall back to the folded words capitalised.
  const words = original.replace(/[’']/g, " ").split(/\s+/).filter(Boolean);
  const folded = words.map((w) => fold(w).split(" ").filter(Boolean));
  const tailWords = tail.split(" ");
  let kept: string[] | null = null;
  for (let i = 0; i < words.length && !kept; i++) {
    const acc: string[] = [];
    let j = i;
    while (acc.length < tailWords.length && j < words.length) { acc.push(...folded[j]); j++; }
    if (acc.length === tailWords.length && acc.every((w, k) => w === tailWords[k])) kept = words.slice(i, j);
  }
  kept = kept ?? tailWords.map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return kept.join(" ").replace(/[?.!…]+$/g, "").split(/\s*(?:,|\bet\b|&|\/)\s*/i).map((b) => b.trim()).filter((b) => b.length >= 2 && b.length <= 40).slice(0, 3);
}

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
export function ghostTitle(text: string, quick: QuickResult | QuickFollowUp | null): string {
  if (quick && quick.kind === "creatives") return `Créas ${quick.client.name} · ${quick.periodLabel}`;
  if (quick && quick.kind === "metrics") return `Chiffres ${quick.client.name} · ${quick.periodLabel}`;
  if (quick && quick.kind === "more_like_this") return `${quick.n} visuel${quick.n > 1 ? "s" : ""} en préparation`;
  if (quick && quick.kind === "compare") return `Chiffres · ${quick.periodLabel}`;
  if (quick && quick.kind === "competitor_ads") return quick.brands.length ? `Pubs ${quick.brands.join(" et ")}` : `Concurrents de ${quick.client?.name ?? "…"}`;
  const clean = text.replace(/\s+/g, " ").trim().replace(/^(hello|salut|bonjour|hey|ok)\s+mo[,\s]*/i, "").replace(/^mo[,\s]+/i, "");
  const short = clean.length > 60 ? clean.slice(0, 59).trimEnd() + "…" : clean;
  return short ? short.charAt(0).toUpperCase() + short.slice(1) : "En cours";
}

// ── Fabrique de statics: the copies table at hand (lib/mo/factory-tools.ts) ──

export type FactoryIntent =
  /** « valide tout », « valide 1 à 5 », « valide 1, 4 et 7 », « valide les 3 premiers » */
  | { kind: "factory_approve"; numbers: number[] | "all"; say: string }
  /** « génère 8 visuels », « lance la génération » */
  | { kind: "factory_generate"; n: number | null; say: string }
  /** « repropose les copys », « d'autres copys » */
  | { kind: "factory_repropose"; say: string };

const NUMBER_WORDS: Record<string, number> = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, quinze: 15, vingt: 20, trente: 30, quarante: 40 };
const numOf = (w: string): number | null => (/^\d{1,2}$/.test(w) ? Number(w) : NUMBER_WORDS[w] ?? null);
const APPROVE_VERBS = /\b(valide|valides|valider|validons|approuve|approuver|garde|gardes|garder|prends|prendre|retiens|ok pour)\b/;
const GENERATE_VERBS = /\b(genere|generes|generer|lance|lancer|fabrique|fabriquer|produis|produire|cree|creer|fais|faire)\b/;
const VISUAL_WORDS = /\b(visuels?|images?|creas?|statics?|generation|pubs?)\b/;

/** The numbers a sentence lists: ranges (« 1 à 5 », « de 2 a 4 », « 1-3 »), « les 3 premiers », lists (« 1, 4 et 7 »). */
export function saidNumbers(t: string): number[] {
  const out: number[] = [];
  const range = /(?:de |du )?\b(\d{1,2}|[a-z]+)\s*(?:a|au|jusqu a|-)\s*(\d{1,2}|[a-z]+)\b/g;
  let rest = t;
  for (const m of t.matchAll(range)) {
    const a = numOf(m[1]), b = numOf(m[2]);
    if (a !== null && b !== null && b >= a && b - a < 60) { for (let i = a; i <= b; i++) out.push(i); rest = rest.replace(m[0], " "); }
  }
  const first = rest.match(/\b(?:les |la )?(\d{1,2}|[a-z]+) premier(?:e|s|es)?\b/);
  if (first && numOf(first[1]) !== null) { for (let i = 1; i <= numOf(first[1])!; i++) out.push(i); rest = rest.replace(first[0], " "); }
  for (const w of rest.split(/[^a-z0-9]+/)) { if (/^\d{1,2}$/.test(w)) out.push(Number(w)); }
  return [...new Set(out)].filter((n) => n >= 1 && n <= 60).sort((a, b) => a - b);
}

/**
 * A sentence about the copies of a fabrique (said over its « Copys à valider »
 * table): approve some or all, launch the generation, propose again. Null
 * otherwise. The caller checks that such a table is on the board.
 */
export function parseFactoryIntent(text: string): FactoryIntent | null {
  const t = fold(text);
  if (!t || t.length > 140) return null;
  if (/\b(repropose|reproposer|reproposes|d autres copys?|autres propositions|nouveaux copys?|refais les copys?)\b/.test(t)) return { kind: "factory_repropose", say: "Je repropose des copys, une minute." };
  if (APPROVE_VERBS.test(t) && !/\b(comme ca|autres?)\b/.test(t)) {
    if (/\b(tout|tous|toutes|l ensemble)\b/.test(t)) return { kind: "factory_approve", numbers: "all", say: "Je valide tous les copys." };
    const numbers = saidNumbers(t);
    if (numbers.length) return { kind: "factory_approve", numbers, say: numbers.length === 1 ? `Je valide le copy ${numbers[0]}.` : `Je valide ${numbers.length} copys.` };
    return null;
  }
  if (GENERATE_VERBS.test(t) && (VISUAL_WORDS.test(t) || /\b(go|c est parti)\b/.test(t)) && !/\b(comme ca|autres?|variantes?|pour [a-z]{3,})\b/.test(t)) {
    const m = t.match(/\b(\d{1,2}|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|quinze|vingt|trente|quarante)\s+(visuels?|images?|creas?|statics?|pubs?)\b/);
    const n = m ? numOf(m[1]) : null;
    return { kind: "factory_generate", n, say: n ? `Je lance ${n} visuels, une à trois minutes.` : "Je lance la génération, une à trois minutes." };
  }
  return null;
}

