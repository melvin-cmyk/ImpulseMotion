/**
 * Meta "actions" (insights `actions` / `action_values` / `cost_per_action_type`)
 * as dashboard material: readable labels, alias de-duplication, per-type
 * summary, and the per-widget conversion-event override.
 * Client-safe: no server imports.
 */

type ActionList = Array<{ action_type: string; value: string }> | undefined;

/** Per-widget conversion override: same grammar as AccountSetting.conversionEvent,
 *  with custom action types allowed to carry Meta's pixel event names. */
export const CONVERSION_EVENT_RE = /^(purchase|lead|complete_registration|custom:[A-Za-z0-9_.:-]{1,200})$/;

export const CONVERSION_PRESETS: Array<{ value: string; label: string }> = [
  { value: "purchase", label: "Achats" },
  { value: "lead", label: "Leads" },
  { value: "complete_registration", label: "Inscriptions" },
];

/** Normalises an optional override: "" / null / undefined → null (account default). Throws on garbage. */
export function parseConversionEvent(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const ev = String(raw).trim();
  if (!ev) return null;
  if (!CONVERSION_EVENT_RE.test(ev)) {
    throw new Error(`Action de conversion invalide: ${ev} (purchase, lead, complete_registration ou custom:<action_type>)`);
  }
  return ev;
}

const ACTION_LABELS: Record<string, string> = {
  link_click: "Clics sur lien",
  outbound_click: "Clics sortants",
  landing_page_view: "Vues de page de destination",
  page_engagement: "Interactions avec la page",
  post_engagement: "Interactions avec la publication",
  post_interaction_gross: "Interactions (brutes)",
  post_reaction: "Réactions",
  post: "Partages",
  comment: "Commentaires",
  like: "J'aime la page",
  photo_view: "Vues de photo",
  video_view: "Vues de vidéo (3 s)",
  post_save: "Enregistrements",
  "onsite_conversion.post_save": "Enregistrements",
  view_content: "Vues de contenu",
  omni_view_content: "Vues de contenu",
  search: "Recherches",
  omni_search: "Recherches",
  add_to_cart: "Ajouts au panier",
  omni_add_to_cart: "Ajouts au panier",
  add_to_wishlist: "Ajouts à la liste de souhaits",
  initiate_checkout: "Paiements initiés",
  omni_initiated_checkout: "Paiements initiés",
  add_payment_info: "Infos de paiement ajoutées",
  omni_add_payment_info: "Infos de paiement ajoutées",
  purchase: "Achats",
  omni_purchase: "Achats",
  lead: "Leads",
  "onsite_conversion.lead_grouped": "Leads (formulaires Meta)",
  "offsite_conversion.fb_pixel_lead": "Leads (site web)",
  complete_registration: "Inscriptions",
  omni_complete_registration: "Inscriptions",
  contact_total: "Contacts",
  "onsite_conversion.messaging_conversation_started_7d": "Conversations démarrées",
  "onsite_conversion.messaging_first_reply": "Premières réponses (messagerie)",
  "onsite_conversion.total_messaging_connection": "Connexions messagerie",
  schedule_total: "Rendez-vous",
  submit_application_total: "Candidatures envoyées",
  subscribe_total: "Abonnements",
  start_trial_total: "Essais démarrés",
  find_location_total: "Recherches de magasin",
  app_install: "Installations d'app",
  mobile_app_install: "Installations d'app",
  "app_custom_event.fb_mobile_purchase": "Achats (app)",
};

const PIXEL_PREFIX = "offsite_conversion.fb_pixel_";
const CUSTOM_CONVERSION_PREFIX = "offsite_conversion.custom.";

/**
 * Readable label for an action type. `customNames` maps custom conversion ids
 * (`offsite_conversion.custom.<id>`) to their name in Events Manager.
 */
export function metaActionLabel(type: string, customNames: Record<string, string> = {}): string {
  if (ACTION_LABELS[type]) return ACTION_LABELS[type];
  if (type.startsWith("omni_")) return metaActionLabel(type.slice("omni_".length), customNames);
  if (type.startsWith(CUSTOM_CONVERSION_PREFIX)) {
    const id = type.slice(CUSTOM_CONVERSION_PREFIX.length);
    return customNames[id] ? `${customNames[id]} (conv. perso)` : `Conversion perso ${id}`;
  }
  if (type.startsWith(PIXEL_PREFIX)) {
    const ev = type.slice(PIXEL_PREFIX.length);
    if (ev.startsWith("custom.")) return `${ev.slice("custom.".length)} (événement pixel)`;
    if (ev === "custom") return "Événements pixel personnalisés";
    const base = ACTION_LABELS[ev] ?? ACTION_LABELS[`omni_${ev}`];
    return base ? `${base} (pixel)` : `${ev.replace(/_/g, " ")} (pixel)`;
  }
  return type.replace(/^onsite_conversion\./, "").replace(/[._]/g, " ");
}

/** Readable label for a conversion event (account setting or widget override). */
export function conversionEventLabel(ev: string, customNames: Record<string, string> = {}): string {
  const preset = CONVERSION_PRESETS.find((p) => p.value === ev);
  if (preset) return preset.label;
  if (ev.startsWith("custom:")) return metaActionLabel(ev.slice("custom:".length), customNames);
  return ev;
}

/** Whether labelling these action types needs the account's custom conversion names. */
export function needsCustomNames(types: string[]): boolean {
  return types.some((t) => t.replace(/^custom:/, "").startsWith(CUSTOM_CONVERSION_PREFIX));
}

export interface MetaActionRow {
  actionType: string;
  count: number;
  /** Tracked value (action_values), null when Meta reports none. */
  value: number | null;
  /** Meta's cost_per_action_type, else spend / count; null when count is 0. */
  costPer: number | null;
}

const num = (v: string | undefined) => {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : 0;
};

function toMap(list: ActionList): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of list ?? []) m.set(a.action_type, num(a.value));
  return m;
}

/** Channel-specific duplicates of a base event (`purchase`, `add_to_cart`…). */
const ALIAS_PREFIXES = ["onsite_web_app_", "onsite_web_", "web_app_in_store_", "web_in_store_", "onsite_app_", PIXEL_PREFIX];

/** Base event name when `type` is a known alias form, else null. */
function aliasBase(type: string): string | null {
  if (type.startsWith("omni_")) return null;
  for (const p of ALIAS_PREFIXES) {
    if (type.startsWith(p)) return type.slice(p.length);
  }
  return type.includes(".") ? null : type;
}

/**
 * Meta reports the same conversions under several types (omni_purchase,
 * purchase, offsite_conversion.fb_pixel_purchase, onsite_web_purchase…).
 * An alias is hidden when a more canonical type carries the exact same count:
 * a real difference (e.g. pixel vs total) stays visible.
 */
export function dedupeActionTypes(counts: Map<string, number>): Set<string> {
  const hidden = new Set<string>();
  for (const [type, count] of counts) {
    const base = aliasBase(type);
    if (base === null) continue;
    const canon = [`omni_${base}`, base === "initiate_checkout" ? "omni_initiated_checkout" : "", base]
      .filter((c) => c && c !== type);
    if (canon.some((c) => counts.has(c) && counts.get(c) === count)) hidden.add(type);
  }
  return hidden;
}

/**
 * One row per action type of an insight. With `only`, the rows follow that
 * list (0 for types absent on the period); otherwise all types, aliases
 * removed, sorted by count desc.
 */
export function summarizeMetaActions(
  insight: { spend?: string; actions?: ActionList; action_values?: ActionList; cost_per_action_type?: ActionList },
  only?: string[],
): MetaActionRow[] {
  const counts = toMap(insight.actions);
  const values = toMap(insight.action_values);
  const costs = toMap(insight.cost_per_action_type);
  const spend = num(insight.spend);
  const row = (actionType: string): MetaActionRow => {
    const count = counts.get(actionType) ?? 0;
    const cost = costs.get(actionType) ?? 0;
    return {
      actionType,
      count,
      value: values.has(actionType) ? values.get(actionType)! : null,
      costPer: cost > 0 ? cost : count > 0 && spend > 0 ? spend / count : null,
    };
  };
  if (only && only.length > 0) return only.map(row);
  const hidden = dedupeActionTypes(counts);
  return [...counts.keys()]
    .filter((t) => !hidden.has(t) && (counts.get(t) ?? 0) > 0)
    .map(row)
    .sort((a, b) => b.count - a.count);
}
