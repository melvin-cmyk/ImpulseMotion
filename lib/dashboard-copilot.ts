/**
 * System prompt for the consultant copilot on /d/[id] (Lot 4).
 *
 * The AI proposes dashboard changes as fenced ```action blocks; nothing is
 * applied until the consultant clicks "Appliquer" — the UI then goes through
 * the normal widget CRUD APIs, which re-validate config and ACL. The AI never
 * writes to the database itself.
 */

import { CONVERSION_WIDGET_TYPES, WIDGET_TYPE_INFO, WIDGET_TYPES, type WidgetType } from "@/lib/dashboard-types";
import { SHEETS_SHARE_EMAIL } from "@/lib/mcp-whitelist";

interface DashboardForPrompt {
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  widgets: Array<{ id: string; type: string; title: string | null; width: string; position: number; config: string; pageId?: string | null }>;
  pages?: Array<{ id: string; name: string; position: number }>;
}

export function buildCopilotSystemPrompt(
  dashboard: DashboardForPrompt,
  clientLabel: string,
  hq: { slug: string; brief: string } | null = null,
): string {
  const pages = dashboard.pages ?? [];
  const pageName = (pageId: string | null | undefined) => {
    if (!pages.length) return null;
    return pages.find((x) => x.id === pageId)?.name ?? "Général";
  };
  const widgetList = dashboard.widgets
    .map((w) => {
      let cfg = w.config;
      try { cfg = JSON.stringify(JSON.parse(w.config)); } catch { /* keep raw */ }
      const page = pageName(w.pageId);
      return `- id=${w.id} | ${page ? `page="${page}" | ` : ""}position=${w.position} | type=${w.type} | width=${w.width} | titre="${w.title ?? ""}" | config=${cfg}`;
    })
    .join("\n");
  const pageList = pages.length
    ? `\nPages (onglets) du dashboard : "Général" (pageId=__default, les widgets sans page), ${pages.map((p) => `"${p.name}" (pageId=${p.id})`).join(", ")}.`
    : "";

  const catalogue = WIDGET_TYPES
    .map((t: WidgetType) => `- ${t} (${WIDGET_TYPE_INFO[t].label}) : config ${WIDGET_TYPE_INFO[t].configDoc}`)
    .join("\n");
  const hqBlock = hq
    ? `\n\nCE QUE L'AGENCE SAIT DU CLIENT (HQ, dossier projects/${hq.slug} — objectifs, KPI cible, décisions, tests, règles) :\n${hq.brief}\nCe brief suffit pour la plupart des questions : n'interroge HQ (outils hq_*) que pour un détail qui n'y figure pas.`
    : "";

  return `Tu es le copilote IA d'ImpulseMotion pour les consultants. Tu aides à composer le dashboard de pilotage du client "${clientLabel}".

ÉTAT ACTUEL DU DASHBOARD "${dashboard.name}" :
Compte Meta lié : ${dashboard.metaAccountId ?? "aucun"}
Compte Google Ads lié : ${dashboard.googleCustomerId ?? "aucun"}
Widgets (ordonnés par position) :
${widgetList || "(aucun widget)"}${pageList}

CATALOGUE DES WIDGETS DISPONIBLES :
${catalogue}
Largeurs valides : third (1/3), half (1/2), full (pleine largeur).
Option commune aux widgets ${CONVERSION_WIDGET_TYPES.join(", ")} : conversionEvent?: purchase|lead|complete_registration|custom:<action_type Meta> (ex. custom:offsite_conversion.custom.123) — action de conversion Meta comptée par ce widget à la place du réglage du compte ; sans effet côté Google.${hqBlock}

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

Pour les questions de données (performances, comparaisons), tu peux utiliser les outils MCP disponibles, mais UNIQUEMENT sur les comptes listés ci-dessus.

FICHIERS PARTAGÉS PAR LE CONSULTANT :
- Images (captures d'écran, créas, graphiques) : elles arrivent jointes au message ; décris ce que tu y vois et exploite-le.
- Tableurs (Excel, CSV) : ils passent par Google Sheets. Le consultant doit importer le fichier dans Google Sheets, partager la feuille avec ${SHEETS_SHARE_EMAIL} en ÉDITEUR, puis te coller le lien. Lis-la avec les outils Google Sheets (search_sheet / Get rows) : Document = l'ID du document tiré du lien (la partie entre /d/ et /edit), Sheet = le nom de l'onglet (demande-le ou essaie le premier). Si un outil répond que le document est introuvable ou l'accès refusé, dis au consultant de vérifier le partage avec ${SHEETS_SHARE_EMAIL}.
Réponds en français, de façon concise et actionnable.`;
}
