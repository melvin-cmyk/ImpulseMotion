/**
 * What Mo is doing, in Mo's own words. The relay's activity state (lib/ai-activity)
 * names tools; the consultant reads an action: « je cherche dans l'entrepôt »,
 * « je génère les visuels »… Never « démarrage », never a raw tool name.
 * Client-safe, pure.
 */

import type { ActivityState } from "@/lib/ai-activity";

export const MO_STATUS = {
  warehouse: "je cherche dans l'entrepôt",
  library: "je lis la bibliothèque Meta",
  generate: "je génère les visuels",
  publish: "je prépare la publication",
  think: "je réfléchis",
  write: "je prépare la réponse",
  live: "je lis les données en direct",
  memory: "je relis la mémoire du client",
  verdict: "je consigne ton verdict",
  editor: "j'ouvre l'éditeur",
  drive: "je range dans le Drive",
  upload: "je range le fichier",
  send: "j'envoie la publicité (en pause)",
  sheet: "j'écris la feuille",
  copy: "j'écris les copys",
  study: "j'étudie la bibliothèque de la marque",
} as const;

export type MoStatusKey = keyof typeof MO_STATUS;

/** The action behind a tool name (raw MCP name, « mcp__mo__creatives »). */
export function toolStatusKey(name: string | null | undefined): MoStatusKey {
  if (!name) return "think";
  const n = name.toLowerCase();
  if (n.startsWith("mcp__mo__")) {
    const tool = n.slice("mcp__mo__".length);
    if (/^(creatives|metrics|creative_metrics)/.test(tool)) return "warehouse";
    if (/^(competitor_ads|keep_template)/.test(tool)) return "library";
    if (/^(generate_creatives|factory_generate)/.test(tool)) return "generate";
    if (/^(factory_propose|factory_approve)/.test(tool)) return "copy";
    if (/^brand_playbook/.test(tool)) return "study";
    if (/^(meta_publish_ad|meta_targets)/.test(tool)) return "publish";
    return "think";
  }
  if (/^mcp__(meta-ads|mcp-google-ads|mcp-tiktok-ads|mcp-google-analytics|mcp-merchant)/.test(n)) return "live";
  if (/^mcp__(hq|claude_ai_mcp_hq)/.test(n)) return "memory";
  return "think";
}

/** The line shown while an action of the board runs (lib/mo/act.ts), by action. */
export function actStatusLabel(action: string): string {
  switch (action) {
    case "verdict": return MO_STATUS.verdict;
    case "creative_metrics": return MO_STATUS.warehouse;
    case "open_editor": return MO_STATUS.editor;
    case "drive": return MO_STATUS.drive;
    case "competitor_ads": return MO_STATUS.library;
    case "publish_prepare": return MO_STATUS.publish;
    case "publish_confirm": return MO_STATUS.send;
    case "upload": return MO_STATUS.upload;
    case "sheet": return MO_STATUS.sheet;
    default: return MO_STATUS.think;
  }
}

/** The action behind a quick intent (lib/mo/intents.ts kinds). */
export function quickStatusKey(kind: string): MoStatusKey {
  if (kind === "more_like_this" || kind === "generate_creatives" || kind === "factory_generate") return "generate";
  if (kind === "factory_approve" || kind === "factory_repropose") return "copy";
  if (kind === "competitor_ads") return "library";
  return "warehouse";
}

/** One line for the status area, from the activity of the running turn. */
export function moStatusLabel(activity: ActivityState | null | undefined, path: "quick" | "model" | `quick:${string}` = "model"): string {
  if (path === "quick") return MO_STATUS.warehouse;
  if (path.startsWith("quick:")) return MO_STATUS[quickStatusKey(path.slice(6))];
  if (!activity) return MO_STATUS.think;
  switch (activity.phase) {
    case "running":
    case "preparing":
      return MO_STATUS[toolStatusKey(activity.tool)];
    case "writing":
      return MO_STATUS.write;
    case "starting":
    case "thinking":
    default:
      return MO_STATUS.think;
  }
}
