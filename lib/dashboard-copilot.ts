/**
 * System prompt for the consultant copilot on /d/[id] (Lot 4).
 *
 * The AI proposes dashboard changes as fenced ```action blocks; nothing is
 * applied until the consultant clicks "Appliquer" — the UI then goes through
 * the normal widget CRUD APIs, which re-validate config and ACL. The AI never
 * writes to the database itself.
 *
 * Two parts: the system prompt (instructions, then the client after the cache
 * boundary) and the turn context (the dashboard's current state).
 */

import { CONVERSION_WIDGET_TYPES, WIDGET_TYPE_INFO, WIDGET_TYPES, type WidgetType } from "@/lib/dashboard-types";
import { staffSignature, staffToolGuidance, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@/lib/ai-tool-guidance";

interface DashboardForPrompt {
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  /** TikTok Ads advertisers attached (widgets source "tiktok"). */
  tiktokAdvertiserIds?: string[];
  widgets: Array<{ id: string; type: string; title: string | null; width: string; position: number; config: string; pageId?: string | null }>;
  pages?: Array<{ id: string; name: string; position: number }>;
}

/**
 * Room for the dashboard's state in a user message. Below the relay's own cap
 * (TURN_CONTEXT_MAX_CHARS in server/relay-prompt.mjs, 20 000), which cuts
 * blindly: the state is shortened here, where its structure is known.
 */
export const COPILOT_CONTEXT_MAX_CHARS = 18_000;

// Long strings of a config (the markdown of a text widget, up to 5 000
// characters each) kept to this many characters, tried in this order until
// the state fits; null = the config is left out.
const CONFIG_TEXT_LIMITS = [Infinity, 600, 200, 60, null] as const;

function shortenStrings(value: unknown, limit: number): unknown {
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}… [+${value.length - limit} caractères]` : value;
  if (Array.isArray(value)) return value.map((v) => shortenStrings(v, limit));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shortenStrings(v, limit)]));
  return value;
}

/** A widget's config on one line: valid JSON whatever the limit, never cut in the middle. */
function configText(raw: string, limit: number | null): string {
  if (limit === null) return "(omise)";
  try { return JSON.stringify(shortenStrings(JSON.parse(raw), limit)); }
  catch { return String(shortenStrings(raw.replace(/\s*\n\s*/g, " "), limit)); }
}

/**
 * What moves while the consultant works: widgets, pages, linked accounts. A
 * resumed relay session keeps the system prompt of its first turn, so this
 * state travels with the user message instead (`turnContext`) — the relay
 * sends it on the first turn and again only when it has changed.
 *
 * A state that does not fit in `maxChars` is shortened, and says so: the long
 * texts of the configs first, then the configs, then the last widgets — whole
 * lines, every widget that is listed keeps its id, type and title.
 */
export function buildCopilotTurnContext(dashboard: DashboardForPrompt, maxChars: number = COPILOT_CONTEXT_MAX_CHARS): string {
  const pages = dashboard.pages ?? [];
  const pageName = (pageId: string | null | undefined) => {
    if (!pages.length) return null;
    return pages.find((x) => x.id === pageId)?.name ?? "Général";
  };
  const pageList = pages.length
    ? `\nPages (onglets) du dashboard : "Général" (pageId=__default, les widgets sans page), ${pages.map((p) => `"${p.name}" (pageId=${p.id})`).join(", ")}.`
    : "";
  const render = (limit: number | null, listed: number) => {
    const lines = dashboard.widgets.slice(0, listed).map((w) => {
      const page = pageName(w.pageId);
      return `- id=${w.id} | ${page ? `page="${page}" | ` : ""}position=${w.position} | type=${w.type} | width=${w.width} | titre="${w.title ?? ""}" | config=${configText(w.config, limit)}`;
    });
    const notes: string[] = [];
    if (limit === null) notes.push("ÉTAT ABRÉGÉ : les configs sont omises faute de place. update_widget fusionne la config : ne renvoie que les champs que tu changes, et demande au consultant la valeur actuelle d'un champ si tu en as besoin.");
    else if (limit !== Infinity) notes.push("ÉTAT ABRÉGÉ : les textes longs des configs sont coupés (« … [+N caractères] »). Ne renvoie jamais un texte coupé dans une action : un champ texte n'est renvoyé que réécrit en entier.");
    const missing = dashboard.widgets.length - listed;
    if (missing > 0) notes.push(`${missing} widget(s) non listé(s) faute de place, sur ${dashboard.widgets.length} : positions ${dashboard.widgets[listed].position} et suivantes.`);
    return `[ÉTAT ACTUEL DU DASHBOARD "${dashboard.name}" — remplace tout état donné plus haut dans la conversation
Compte Meta lié : ${dashboard.metaAccountId ?? "aucun"}
Compte Google Ads lié : ${dashboard.googleCustomerId ?? "aucun"}${dashboard.tiktokAdvertiserIds?.length ? `\nComptes TikTok Ads liés : ${dashboard.tiktokAdvertiserIds.join(", ")} (source "tiktok" des widgets kpi, timeseries et table de campagnes)` : ""}${notes.length ? `\n${notes.join("\n")}` : ""}
Widgets (ordonnés par position) :
${lines.join("\n") || "(aucun widget)"}${pageList}]`;
  };
  for (const limit of CONFIG_TEXT_LIMITS) {
    const state = render(limit, dashboard.widgets.length);
    if (state.length <= maxChars) return state;
  }
  let listed = dashboard.widgets.length;
  let state = render(null, listed);
  while (state.length > maxChars && listed > 0) state = render(null, --listed);
  return state;
}

/**
 * Does the relay that answered /health take the dashboard's state in
 * `turnContext` ? A relay started before that field existed ignores it
 * without a word, and the copilot would see no widget and no account: the
 * state then stays in the system prompt, as it used to.
 */
export function relayTakesTurnContext(health: unknown): boolean {
  const caps = health && typeof health === "object" ? (health as { capabilities?: unknown }).capabilities : null;
  return Array.isArray(caps) && caps.includes("turnContext");
}

/**
 * Static instructions first (identical for every dashboard and consultant,
 * hence shared in the prompt cache), then the boundary, then what belongs to
 * this client. The dashboard's state is not here (see buildCopilotTurnContext),
 * unless `inlineState` is given: the state for a relay that does not take
 * `turnContext` yet (relayTakesTurnContext), put last, after the boundary.
 */
export function buildCopilotSystemPrompt(
  dashboard: Pick<DashboardForPrompt, "name">,
  clientLabel: string,
  hq: { slug: string; brief: string } | null = null,
  author: string | null = null,
  inlineState: string | null = null,
): string {
  const catalogue = WIDGET_TYPES
    .map((t: WidgetType) => `- ${t} (${WIDGET_TYPE_INFO[t].label}) : config ${WIDGET_TYPE_INFO[t].configDoc}`)
    .join("\n");
  const hqBlock = hq
    ? `CE QUE L'AGENCE SAIT DU CLIENT (HQ, dossier projects/${hq.slug} — objectifs, KPI cible, décisions, tests, règles) :\n${hq.brief}\nLe dossier HQ de ce client est projects/${hq.slug} : c'est là que va une note de journal demandée par le consultant.`
    : "";

  return `Tu es le copilote IA d'ImpulseMotion pour les consultants. Tu aides à composer le dashboard de pilotage d'un client de l'agence (nommé en fin de prompt).

ÉTAT DU DASHBOARD : il t'est donné entre crochets ([ÉTAT ACTUEL DU DASHBOARD …] : comptes liés, widgets, pages), dans le message de l'utilisateur — au début de la conversation puis à chaque fois qu'il change — ou, à défaut, en fin de prompt. Le plus récent fait foi.

CATALOGUE DES WIDGETS DISPONIBLES :
${catalogue}
Largeurs valides : third (1/3), half (1/2), full (pleine largeur).
Option commune aux widgets ${CONVERSION_WIDGET_TYPES.join(", ")} : conversionEvent?: purchase|lead|complete_registration|custom:<action_type Meta> (ex. custom:offsite_conversion.custom.123) — action de conversion Meta comptée par ce widget à la place du réglage du compte ; sans effet côté Google.

HQ (mémoire de l'agence) : ne le consulte (outils hq_*) que si le consultant te le demande explicitement — jamais de ta propre initiative avant une analyse ou une modification du dashboard.

COMMENT PROPOSER DES MODIFICATIONS :
RÈGLE ABSOLUE : toute modification du dashboard DOIT être émise dans un bloc de code au langage "action" — sans ce bloc, rien ne peut être appliqué. Réponds brièvement puis émets un ou plusieurs blocs, contenant CHACUN un unique objet JSON valide (pas de commentaire dans le JSON) :
\`\`\`action
{"action":"add_widget","type":"timeseries","title":"ROAS quotidien","width":"full","config":{"metric":"roas","source":"meta"}}
\`\`\`
Formes valides :
- {"action":"add_widget","type":"<type>","title":"...","width":"third|half|full","config":{...},"pageId":"<pageId optionnel — page cible, sinon la première>"}
- {"action":"update_widget","widgetId":"<id>","title":"...","width":"...","config":{...}} — config est FUSIONNÉE avec l'existante : ne mets que les champs à changer
- {"action":"remove_widget","widgetId":"<id>"}
- {"action":"reorder","order":["<id1>","<id2>",...]} (liste complète des ids dans le nouvel ordre)
Utilise UNIQUEMENT les types, métriques et sources listés dans le catalogue ci-dessus — une valeur hors catalogue sera rejetée à l'application.
Le consultant voit chaque proposition et clique Appliquer ou Refuser — n'affirme jamais qu'un changement est fait, dis qu'il est proposé.

Pour les questions de données (performances, comparaisons), tu peux utiliser les outils MCP disponibles, mais UNIQUEMENT sur les comptes liés au dashboard (restrictions de périmètre en fin de prompt).

${staffToolGuidance()}
Réponds en français, de façon concise et actionnable.
${SYSTEM_PROMPT_DYNAMIC_BOUNDARY}
CLIENT : "${clientLabel}" — dashboard "${dashboard.name}".${hqBlock ? `\n\n${hqBlock}` : ""}
${staffSignature(author)}${inlineState ? `\n\n${inlineState}` : ""}`;
}
