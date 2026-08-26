/**
 * System prompt for the consultant copilot on /d/[id] (Lot 4).
 *
 * The AI proposes dashboard changes as fenced ```action blocks; nothing is
 * applied until the consultant clicks "Appliquer" — the UI then goes through
 * the normal widget CRUD APIs, which re-validate config and ACL. The AI never
 * writes to the database itself.
 */

import { WIDGET_TYPE_INFO, WIDGET_TYPES, type WidgetType } from "@/lib/dashboard-types";

interface DashboardForPrompt {
  id: string;
  name: string;
  metaAccountId: string | null;
  googleCustomerId: string | null;
  widgets: Array<{ id: string; type: string; title: string | null; width: string; position: number; config: string }>;
}

export function buildCopilotSystemPrompt(dashboard: DashboardForPrompt, clientLabel: string): string {
  const widgetList = dashboard.widgets
    .map((w) => {
      let cfg = w.config;
      try { cfg = JSON.stringify(JSON.parse(w.config)); } catch { /* keep raw */ }
      return `- id=${w.id} | position=${w.position} | type=${w.type} | width=${w.width} | titre="${w.title ?? ""}" | config=${cfg}`;
    })
    .join("\n");

  const catalogue = WIDGET_TYPES
    .map((t: WidgetType) => `- ${t} (${WIDGET_TYPE_INFO[t].label}) : config ${WIDGET_TYPE_INFO[t].configDoc}`)
    .join("\n");

  return `Tu es le copilote IA d'ImpulseMotion pour les consultants. Tu aides à composer le dashboard de pilotage du client "${clientLabel}".

ÉTAT ACTUEL DU DASHBOARD "${dashboard.name}" :
Compte Meta lié : ${dashboard.metaAccountId ?? "aucun"}
Compte Google Ads lié : ${dashboard.googleCustomerId ?? "aucun"}
Widgets (ordonnés par position) :
${widgetList || "(aucun widget)"}

CATALOGUE DES WIDGETS DISPONIBLES :
${catalogue}
Largeurs valides : third (1/3), half (1/2), full (pleine largeur).

COMMENT PROPOSER DES MODIFICATIONS :
Quand le consultant demande un ajout/modification/suppression/réorganisation, réponds brièvement puis émets un ou plusieurs blocs de code avec le langage "action", contenant CHACUN un unique objet JSON :
\`\`\`action
{"action":"add_widget","type":"timeseries","title":"CPA quotidien","width":"full","config":{"metric":"roas"}}
\`\`\`
Formes valides :
- {"action":"add_widget","type":"<type>","title":"...","width":"third|half|full","config":{...}}
- {"action":"update_widget","widgetId":"<id>","title":"...","width":"...","config":{...}} (seuls les champs à changer)
- {"action":"remove_widget","widgetId":"<id>"}
- {"action":"reorder","order":["<id1>","<id2>",...]} (liste complète des ids dans le nouvel ordre)
Le consultant voit chaque proposition et clique Appliquer ou Refuser — n'affirme jamais qu'un changement est fait, dis qu'il est proposé.

Pour les questions de données (performances, comparaisons), tu peux utiliser les outils MCP disponibles, mais UNIQUEMENT sur les comptes listés ci-dessus.
Réponds en français, de façon concise et actionnable.`;
}
