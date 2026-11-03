/** Categories of the Glossaire (client-safe): Motion's AI tag categories + our message themes. */
import { AI_TAG_KEYS, AI_TAG_LABELS } from "./ai-tags-labels";

export const GLOSSARY_KEYS = [...AI_TAG_KEYS, "ai:msg"] as const;
export type GlossaryKey = (typeof GLOSSARY_KEYS)[number];

export const GLOSSARY_LABELS: Record<GlossaryKey, string> = { ...AI_TAG_LABELS, "ai:msg": "Thème de message (analyse)" };

export const GLOSSARY_HELP: Record<GlossaryKey, string> = {
  "ai:type": "Nature de l'asset : UGC, motion design, photo produit…",
  "ai:format": "Style visuel qui porte le message.",
  "ai:audience": "Persona visé par la créa.",
  "ai:theme": "Sujet principal du message.",
  "ai:season": "Moment ou saison mis en avant.",
  "ai:offer": "Promo, essai, livraison offerte…",
  "ai:hook": "Ce qui arrête le scroll dans les premières secondes.",
  "ai:headline": "Mécanique du titre.",
  "ai:msg": "Promesse du client, issue de « Thèmes de message ».",
};

/** « Type d'asset » cannot be removed: an ad without it is tagged again by the AI. */
export const GLOSSARY_REQUIRED: GlossaryKey[] = ["ai:type"];
