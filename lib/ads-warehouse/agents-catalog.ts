/**
 * Agents IA of the Analyse Ads (Motion's AI agent workflows) — the catalog,
 * client-safe. Each workflow runs on the client's account or on one creative,
 * reads the warehouse (+ playbook, glossary, comments) and answers in
 * sections the team scores 👍 / 👎 and can question further.
 */

export type AgentScope = "account" | "creative";

export interface AgentWorkflow {
  key: string;
  scope: AgentScope;
  title: string;
  description: string;
  /** Placeholder of the optional instruction. */
  inputHint: string;
  /** Needs the Meta comments (META_COMMENTS + Page assigned). */
  needsComments?: boolean;
}

export const AGENT_WORKFLOWS: AgentWorkflow[] = [
  {
    key: "creative_breakdown", scope: "creative", title: "Décortiquer la créa",
    description: "Pourquoi elle marche (ou pas) : hook, message, format, chiffres face à la moyenne du compte, ce qu'il faut garder.",
    inputHint: "Ex. : focus sur la rétention vidéo",
  },
  {
    key: "creative_iterations", scope: "creative", title: "5 itérations à tester",
    description: "Cinq variations prêtes à briefer (hook, visuel, angle, format), chacune avec l'hypothèse qu'elle teste.",
    inputHint: "Ex. : garder le même visuel, changer seulement l'accroche",
  },
  {
    key: "creative_voice", scope: "creative", title: "Voix du client",
    description: "Ce que disent les gens sous la pub : désirs, objections, mots exacts à reprendre, idées de hooks.",
    inputHint: "Ex. : chercher surtout les objections prix",
    needsComments: true,
  },
  {
    key: "account_brief", scope: "account", title: "Brief de la prochaine vague",
    description: "Trois concepts de créas à produire, fondés sur les gagnantes, le playbook et les angles peu testés.",
    inputHint: "Ex. : lancement produit en décembre, budget limité",
  },
  {
    key: "account_fatigue", scope: "account", title: "Audit de fatigue",
    description: "Les créas qui s'essoufflent face à la période précédente, celles à remplacer en premier et par quoi.",
    inputHint: "Ex. : ignorer les créas catalogue",
  },
  {
    key: "account_gaps", scope: "account", title: "Angles inexploités",
    description: "Lecture du glossaire : ce qui est sur-testé, ce qui performe avec peu de budget, ce qui n'a jamais été tenté.",
    inputHint: "Ex. : se concentrer sur les personas",
  },
];

export const AGENT_BY_KEY: Record<string, AgentWorkflow> = Object.fromEntries(AGENT_WORKFLOWS.map((w) => [w.key, w]));

export interface AgentSection { title: string; body: string }
export interface AgentFollowup { prompt: string; answer: string; at: string; by: string }
export interface AgentRunView {
  id: string; workflow: string; creativeKey: string | null; label: string; input: string;
  status: "running" | "done" | "error"; error: string;
  sections: AgentSection[]; scores: Record<string, 1 | -1>; followups: AgentFollowup[];
  createdByName: string; createdAt: string;
}
