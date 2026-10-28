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

const NAV_VERBS = /\b(ouvre|ouvrir|ouvres|va sur|vas sur|aller sur|allons sur|emmene moi|amene moi|montre moi|montre|affiche|afficher|lance|accede a|acceder a|direction|on va sur)\b/;
/** Words that make it a data question, not a navigation. */
const DATA_WORDS = /\b(cpa|cpl|cpm|cpc|ctr|roas|lead|leads|depense|depenses|budget|conversion|conversions|achat|achats|vente|ventes|impression|impressions|clic|clics|resultat|resultats|chiffre|chiffres|combien|compare|comparer|comparaison|evolution|hier|aujourd hui|semaine|mois|jour|jours|vendredi|lundi|mardi|mercredi|jeudi|samedi|dimanche|periode|depuis|entre|top|meilleur|meilleure|meilleurs|pire|baisse|hausse|tendance|poste|postees|postes|lancees|lancee|creees|creee|performance|performances|kpi|kpis|tableau de bord|courbe|graphique|note|resume)\b/;

interface Target { re: RegExp; label: string; path: (c: IntentClient | null) => string | null; root: string }
const TARGETS: Target[] = [
  { re: /\b(cockpit|fiche client|fiche|hub|tout le client)\b/, label: "le cockpit", path: (c) => (c ? `/portfolio/${c.id}` : "/cockpit"), root: "/cockpit" },
  { re: /\b(analyse ads|analyse|analyses|creas? ads|ads)\b/, label: "l'Analyse Ads", path: (c) => (c ? `/analyse?client=${c.id}` : "/analyse"), root: "/analyse" },
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
  { re: /\b(tableau|board|mon tableau|mo)\b/, label: "ton tableau Mo", path: () => "/mo", root: "/mo" },
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

/** The client named in the text (exact, token-prefix or one typo), or null when none / ambiguous. */
export function matchClientName(text: string, clients: IntentClient[]): IntentClient | null {
  const t = fold(text);
  const words = t.split(" ").filter(Boolean);
  const best: { c: IntentClient; score: number }[] = [];
  for (const c of clients) {
    const names = [c.name, ...(c.aliases ?? [])].map(fold).filter(Boolean);
    let score = 0;
    for (const name of names) {
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
  const rest = client ? t.replace(fold(client.name), " ").replace(/\s+/g, " ") : t;
  const target = TARGETS.find((x) => x.re.test(rest));
  if (!target) return null;
  const soft = /^(montre|montre moi|affiche|afficher|lance|direction)$/.test(verb);
  if (soft && rest.split(" ").filter(Boolean).length > 9) return null;
  const path = target.path(client);
  if (!path) return null;
  const say = client ? `J'ouvre ${target.label} de ${client.name}.` : `J'ouvre ${target.label}.`;
  return { path, say, label: target.label, clientName: client?.name ?? null };
}
