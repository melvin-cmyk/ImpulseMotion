/**
 * What the AI is doing right now, in words a consultant reads at a glance —
 * shared by the console /ai and the dashboard copilot (client-safe, pure).
 *
 * The relay streams `activity` (the model thinks / writes / prepares a tool),
 * `tool_call` and `tool_result`; `reduceActivity` folds them into one state
 * and `activityLabel` turns it into the line shown next to the spinner.
 */

export interface ActivityState {
  phase: "starting" | "thinking" | "writing" | "preparing" | "running";
  /** Tool being prepared or run (raw MCP name). */
  tool: string | null;
  /** Tool calls started since the beginning of the turn. */
  steps: number;
  /** Tool calls still waiting for their result. */
  pending: string[];
}

export const INITIAL_ACTIVITY: ActivityState = { phase: "starting", tool: null, steps: 0, pending: [] };

const SERVER_LABELS: Array<[string, string]> = [
  ["mcp__meta-ads-impulse__", "Meta"],
  ["mcp__mcp-google-ads__", "Google Ads"],
  ["mcp__mcp-google-analytics__", "GA4"],
  ["mcp__mcp-google-sheet__", "Sheets"],
  ["mcp__claude_ai_mcp_hq__", "HQ"],
  ["mcp__hq__", "HQ"],
  ["mcp__sandbox__", "Python"],
  ["mcp__gws__", "Google Workspace"],
  ["mcp__client-data__", "Données client"],
];

const BUILTIN_LABELS: Record<string, string> = {
  WebSearch: "Recherche web",
  WebFetch: "Lecture de page",
  ToolSearch: "Chargement d'outils",
};

/** Compact name for the list of tool calls ("Meta : Get_Campaigns"). */
export function formatToolName(name: string): string {
  for (const [prefix, label] of SERVER_LABELS) {
    if (name.startsWith(prefix)) return `${label} : ${name.slice(prefix.length).replace(/1$/, "")}`;
  }
  return BUILTIN_LABELS[name] ?? name;
}

const SANDBOX_ACTIONS: Record<string, string> = {
  run_python: "Calcul en cours dans le bac à sable (Python)",
  run_node: "Construction du fichier dans le bac à sable",
  render_pptx: "Rendu des pages pour vérification visuelle",
  list_files: "Inventaire des fichiers de la conversation",
  read_file: "Lecture d'un fichier",
};

const SERVER_ACTIONS: Array<[string, string]> = [
  ["mcp__meta-ads-impulse__", "Lecture des données Meta Ads"],
  ["mcp__mcp-google-ads__", "Lecture des données Google Ads"],
  ["mcp__mcp-google-analytics__", "Lecture des données Google Analytics"],
  ["mcp__mcp-google-sheet__", "Lecture du Google Sheet"],
  ["mcp__claude_ai_mcp_hq__", "Consultation de HQ"],
  ["mcp__hq__", "Consultation de HQ"],
  ["mcp__gws__", "Google Workspace"],
  ["mcp__client-data__", "Lecture des données du client"],
];

/** Sentence describing a running tool ("Lecture des données Meta Ads"). */
export function toolAction(name: string): string {
  if (name.startsWith("mcp__sandbox__")) return SANDBOX_ACTIONS[name.slice("mcp__sandbox__".length)] ?? "Travail dans le bac à sable";
  for (const [prefix, label] of SERVER_ACTIONS) if (name.startsWith(prefix)) return label;
  if (name === "WebSearch") return "Recherche sur le web";
  if (name === "WebFetch") return "Lecture d'une page web";
  if (name === "ToolSearch") return "Chargement des outils";
  return `Outil ${name}`;
}

export type ActivityEvent = { type?: unknown; phase?: unknown; name?: unknown; id?: unknown };

/** Folds one relay event into the state; unrelated events leave it untouched. */
export function reduceActivity(state: ActivityState, event: ActivityEvent): ActivityState {
  const name = typeof event.name === "string" ? event.name : null;
  const id = typeof event.id === "string" ? event.id : "";
  switch (event.type) {
    case "activity":
      if (event.phase === "thinking") return { ...state, phase: "thinking", tool: null };
      if (event.phase === "writing") return { ...state, phase: "writing", tool: null };
      if (event.phase === "tool" && name) return { ...state, phase: "preparing", tool: name };
      return state;
    case "tool_call":
      return { phase: "running", tool: name ?? state.tool, steps: state.steps + 1, pending: [...state.pending, id] };
    case "tool_result": {
      const pending = state.pending.filter((p) => p !== id);
      // Results in, nothing running: the model is reading them.
      return pending.length ? { ...state, pending } : { ...state, phase: "thinking", tool: null, pending };
    }
    case "delta":
    case "content":
      return state.phase === "writing" ? state : { ...state, phase: "writing", tool: null };
    default:
      return state;
  }
}

export function activityLabel(state: ActivityState): string {
  switch (state.phase) {
    case "starting": return "Démarrage de la session";
    case "thinking": return state.steps ? "Analyse des résultats" : "Réflexion";
    case "writing": return "Rédaction de la réponse";
    case "preparing": return state.tool ? `Préparation — ${toolAction(state.tool)}` : "Préparation de l'étape suivante";
    case "running": return state.tool ? toolAction(state.tool) : "Outil en cours";
  }
}

/** "45 s", "2 min 05". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")}`;
}

/** Turns cut by the time budget are relaunched by the chat itself, this many times at most. */
export const MAX_AUTO_CONTINUES = 5;

/** Hidden user message of an automatic relaunch (the relay resumes the session). */
export const AUTO_CONTINUE_PROMPT =
  "[Poursuite automatique] Ton tour précédent a été interrompu par la limite de temps, pas par le consultant. Reprends exactement où tu en étais : vérifie ce qui est déjà produit, ne refais pas ce qui est fait, et va jusqu'au livrable.";
