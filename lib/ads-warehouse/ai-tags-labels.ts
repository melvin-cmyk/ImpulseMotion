/** Labels of the AI tag keys (client-safe; the tagging itself lives in ai-tags.ts). */
export const AI_TAG_KEYS = ["ai:type", "ai:format", "ai:audience", "ai:theme", "ai:season", "ai:offer", "ai:hook", "ai:headline"] as const;
export const AI_TAG_LABELS: Record<(typeof AI_TAG_KEYS)[number], string> = {
  "ai:type": "Type d'asset", "ai:format": "Format visuel", "ai:audience": "Audience visée", "ai:theme": "Thème du message",
  "ai:season": "Saisonnalité", "ai:offer": "Type d'offre", "ai:hook": "Tactique d'accroche", "ai:headline": "Tactique de titre",
};
