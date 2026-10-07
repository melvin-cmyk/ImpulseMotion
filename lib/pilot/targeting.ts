/**
 * Pilotage — the targeting of a Meta ad set, as Pilotage reads, edits and
 * describes it. Meta holds it as one JSON object (`targeting`); Pilotage
 * writes it whole (kind "set_targeting", field "targeting"), so the value
 * before and the value after are two JSON objects, and the journal says the
 * difference in French (age, genders, countries, audiences, placements,
 * Advantage+ audience, the rest named by key).
 *
 * The editor changes a few things (edits); everything else of the object is
 * kept as Meta gave it, so a change of age never touches the interests.
 *
 * Pure: no network, no database.
 */

export type Targeting = Record<string, unknown>;

export interface TargetingEdits {
  ageMin?: number;
  ageMax?: number;
  /** [] = everyone; 1 = men; 2 = women. */
  genders?: number[];
  /** ISO codes; replaces geo_locations.countries only (regions, cities, places are kept). */
  countries?: string[];
  /** Custom audience ids included / excluded (the names are read on Meta before the preview). */
  customAudiences?: string[];
  excludedCustomAudiences?: string[];
  /** null = automatic placements; else the platforms kept. */
  publisherPlatforms?: string[] | null;
  /** Advantage+ audience on / off. */
  advantageAudience?: boolean;
}

export const PUBLISHER_PLATFORMS = ["facebook", "instagram", "audience_network", "messenger", "threads"] as const;
export const GENDER_FR: Record<number, string> = { 1: "hommes", 2: "femmes" };
export const PLATFORM_FR_META: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", audience_network: "Audience Network", messenger: "Messenger", threads: "Threads" };

/** Countries offered in the editor (ISO code → name); any other ISO code is accepted by hand. */
export const COUNTRIES_FR: Record<string, string> = {
  FR: "France", BE: "Belgique", CH: "Suisse", LU: "Luxembourg", MC: "Monaco", DE: "Allemagne", ES: "Espagne", IT: "Italie", PT: "Portugal",
  GB: "Royaume-Uni", IE: "Irlande", NL: "Pays-Bas", AT: "Autriche", DK: "Danemark", SE: "Suède", NO: "Norvège", FI: "Finlande", PL: "Pologne",
  CZ: "Tchéquie", GR: "Grèce", RO: "Roumanie", US: "États-Unis", CA: "Canada", MX: "Mexique", BR: "Brésil", MA: "Maroc", DZ: "Algérie", TN: "Tunisie",
  SN: "Sénégal", CI: "Côte d'Ivoire", ZA: "Afrique du Sud", AE: "Émirats arabes unis", SA: "Arabie saoudite", IL: "Israël", TR: "Turquie",
  JP: "Japon", KR: "Corée du Sud", AU: "Australie", NZ: "Nouvelle-Zélande", IN: "Inde", SG: "Singapour", HK: "Hong Kong", RE: "La Réunion", GP: "Guadeloupe", MQ: "Martinique", GF: "Guyane", YT: "Mayotte", NC: "Nouvelle-Calédonie", PF: "Polynésie française",
};

/** Keys Meta accepts in a targeting spec that Pilotage lets through (whole object written back). */
const ALLOWED_KEYS = new Set([
  "age_min", "age_max", "genders", "geo_locations", "excluded_geo_locations", "custom_audiences", "excluded_custom_audiences", "locales",
  "flexible_spec", "exclusions", "interests", "behaviors", "publisher_platforms", "facebook_positions", "instagram_positions", "messenger_positions",
  "audience_network_positions", "threads_positions", "device_platforms", "user_os", "user_device", "targeting_automation", "targeting_relaxation_types",
  "brand_safety_content_filter_levels", "user_age_unknown", "excluded_publisher_categories", "targeting_optimization", "connections", "excluded_connections",
  "friends_of_connections", "education_statuses", "relationship_statuses", "life_events", "income", "industries", "work_positions", "work_employers",
  "family_statuses", "home_ownership", "home_type", "home_value", "household_composition", "moms", "net_worth", "office_type", "politics", "wireless_carrier",
  "excluded_user_device", "app_install_state", "dynamic_audience_ids", "excluded_dynamic_audience_ids", "product_audience_specs", "excluded_product_audience_specs",
  "contextual_targeting_categories", "excluded_brand_safety_content_types", "prospecting_audience", "catalog_based_targeting", "radius", "zips", "cities", "regions",
  "countries", "country_groups", "custom_locations", "places", "location_types", "geo_markets", "electoral_districts", "location_cluster_ids", "location_expansion", "fb_deal_id", "marketplace_product_categories", "excluded_mobile_device_model", "excluded_engagement_specs",
]);
export const TARGETING_MAX_CHARS = 30_000;

/** Reads a targeting object (JSON or object); the reason in French when it is not one Pilotage writes. */
export function readTargeting(value: unknown): { ok: true; targeting: Targeting } | { ok: false; error: string } {
  let raw: unknown;
  try { raw = typeof value === "string" ? JSON.parse(value) : value; } catch { return { ok: false, error: "Ciblage illisible (JSON invalide)." }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Ciblage illisible." };
  const t = raw as Targeting;
  if (JSON.stringify(t).length > TARGETING_MAX_CHARS) return { ok: false, error: "Ciblage trop long." };
  for (const key of Object.keys(t)) if (!ALLOWED_KEYS.has(key)) return { ok: false, error: `Clé de ciblage inconnue : « ${key} ».` };
  const geo = t.geo_locations as Record<string, unknown> | undefined;
  const hasGeo = geo && typeof geo === "object" && ["countries", "regions", "cities", "zips", "places", "custom_locations", "geo_markets", "country_groups", "location_cluster_ids"].some((k) => Array.isArray(geo[k]) && (geo[k] as unknown[]).length);
  if (!hasGeo) return { ok: false, error: "Le ciblage doit garder au moins un lieu (pays, région, ville…)." };
  if (t.age_min !== undefined && (typeof t.age_min !== "number" || t.age_min < 13 || t.age_min > 65)) return { ok: false, error: "Âge minimum entre 13 et 65." };
  if (t.age_max !== undefined && (typeof t.age_max !== "number" || t.age_max < 13 || t.age_max > 65)) return { ok: false, error: "Âge maximum entre 13 et 65." };
  if (typeof t.age_min === "number" && typeof t.age_max === "number" && t.age_min > t.age_max) return { ok: false, error: "Âge minimum supérieur à l'âge maximum." };
  return { ok: true, targeting: t };
}

/** The object with its keys sorted at every level: two specs that say the same compare equal. */
export function canonicalTargeting(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    return v;
  };
  let parsed: unknown = value;
  if (typeof value === "string") { try { parsed = JSON.parse(value); } catch { return String(value); } }
  return JSON.stringify(sort(parsed));
}

const ids = (list: unknown): Array<{ id: string; name: string }> =>
  Array.isArray(list) ? list.map((a) => (a && typeof a === "object" ? { id: String((a as Record<string, unknown>).id ?? ""), name: String((a as Record<string, unknown>).name ?? "") } : { id: String(a), name: "" })).filter((a) => a.id) : [];

const audienceName = (a: { id: string; name: string }) => a.name || `#${a.id}`;

/** The edits applied on a spec as Meta gave it: what is not edited is kept. */
export function withTargetingEdits(base: Targeting, edits: TargetingEdits): Targeting {
  const t: Targeting = JSON.parse(JSON.stringify(base ?? {}));
  if (edits.ageMin !== undefined) t.age_min = edits.ageMin;
  if (edits.ageMax !== undefined) t.age_max = edits.ageMax;
  if (edits.genders !== undefined) { if (edits.genders.length) t.genders = [...edits.genders].sort(); else delete t.genders; }
  if (edits.countries !== undefined) {
    const geo = (t.geo_locations && typeof t.geo_locations === "object" ? t.geo_locations : {}) as Record<string, unknown>;
    if (edits.countries.length) geo.countries = [...new Set(edits.countries.map((c) => c.toUpperCase()))]; else delete geo.countries;
    t.geo_locations = geo;
  }
  if (edits.customAudiences !== undefined) { if (edits.customAudiences.length) t.custom_audiences = edits.customAudiences.map((id) => ({ id })); else delete t.custom_audiences; }
  if (edits.excludedCustomAudiences !== undefined) { if (edits.excludedCustomAudiences.length) t.excluded_custom_audiences = edits.excludedCustomAudiences.map((id) => ({ id })); else delete t.excluded_custom_audiences; }
  if (edits.publisherPlatforms !== undefined) {
    if (edits.publisherPlatforms === null) {
      for (const k of ["publisher_platforms", "facebook_positions", "instagram_positions", "messenger_positions", "audience_network_positions", "threads_positions"]) delete t[k];
    } else {
      const kept = new Set(edits.publisherPlatforms);
      t.publisher_platforms = PUBLISHER_PLATFORMS.filter((p) => kept.has(p));
      // Positions of a platform no longer chosen would be refused by Meta.
      for (const p of PUBLISHER_PLATFORMS) if (!kept.has(p)) delete t[`${p}_positions`];
    }
  }
  if (edits.advantageAudience !== undefined) {
    const auto = (t.targeting_automation && typeof t.targeting_automation === "object" ? t.targeting_automation : {}) as Record<string, unknown>;
    auto.advantage_audience = edits.advantageAudience ? 1 : 0;
    t.targeting_automation = auto;
  }
  return t;
}

/** A spec said in French, one phrase per thing it holds. */
export function summarizeTargeting(t: Targeting): string[] {
  const out: string[] = [];
  const age = `${typeof t.age_min === "number" ? t.age_min : 18}–${typeof t.age_max === "number" ? t.age_max : 65} ans`;
  const genders = Array.isArray(t.genders) && t.genders.length ? (t.genders as number[]).map((g) => GENDER_FR[g] ?? String(g)).join(" et ") : "tous";
  out.push(`${age}, ${genders}`);
  const geo = (t.geo_locations ?? {}) as Record<string, unknown>;
  const places: string[] = [];
  if (Array.isArray(geo.countries) && geo.countries.length) places.push((geo.countries as string[]).map((c) => COUNTRIES_FR[c] ?? c).join(", "));
  for (const [k, label] of [["regions", "région(s)"], ["cities", "ville(s)"], ["zips", "code(s) postal(aux)"], ["places", "lieu(x)"], ["custom_locations", "zone(s) personnalisée(s)"]] as const) {
    if (Array.isArray(geo[k]) && (geo[k] as unknown[]).length) places.push(`${(geo[k] as unknown[]).length} ${label}`);
  }
  if (places.length) out.push(`lieux : ${places.join(" · ")}`);
  const inc = ids(t.custom_audiences); if (inc.length) out.push(`audiences : ${inc.map(audienceName).join(", ")}`);
  const exc = ids(t.excluded_custom_audiences); if (exc.length) out.push(`exclues : ${exc.map(audienceName).join(", ")}`);
  const flex = Array.isArray(t.flexible_spec) ? (t.flexible_spec as Array<Record<string, unknown>>) : [];
  const interests = flex.flatMap((f) => ids(f.interests).map(audienceName));
  if (interests.length) out.push(`intérêts : ${interests.slice(0, 6).join(", ")}${interests.length > 6 ? ` (+${interests.length - 6})` : ""}`);
  const platforms = Array.isArray(t.publisher_platforms) && t.publisher_platforms.length ? (t.publisher_platforms as string[]).map((p) => PLATFORM_FR_META[p] ?? p).join(", ") : "automatiques";
  out.push(`placements ${platforms}`);
  const auto = (t.targeting_automation ?? {}) as Record<string, unknown>;
  if (auto.advantage_audience === 1) out.push("audience Advantage+ activée");
  return out;
}

const same = (a: unknown, b: unknown) => canonicalTargeting(a ?? null) === canonicalTargeting(b ?? null);

/** What changed between two specs, one line per thing; « ciblage modifié » when nothing named moved. */
export function targetingDiff(before: Targeting | null, after: Targeting): string[] {
  const b = before ?? {};
  const out: string[] = [];
  const ageOf = (t: Targeting) => `${typeof t.age_min === "number" ? t.age_min : 18}–${typeof t.age_max === "number" ? t.age_max : 65} ans`;
  if (ageOf(b) !== ageOf(after)) out.push(`âge ${ageOf(b)} → ${ageOf(after)}`);
  const gOf = (t: Targeting) => (Array.isArray(t.genders) && t.genders.length ? (t.genders as number[]).map((g) => GENDER_FR[g] ?? String(g)).join(" et ") : "tous");
  if (gOf(b) !== gOf(after)) out.push(`genre ${gOf(b)} → ${gOf(after)}`);
  const cOf = (t: Targeting) => { const g = (t.geo_locations ?? {}) as Record<string, unknown>; return Array.isArray(g.countries) ? (g.countries as string[]).map((c) => COUNTRIES_FR[c] ?? c).join(", ") : ""; };
  if (cOf(b) !== cOf(after)) out.push(`pays ${cOf(b) || "—"} → ${cOf(after) || "—"}`);
  const geoRest = (t: Targeting) => { const g = { ...((t.geo_locations ?? {}) as Record<string, unknown>) }; delete g.countries; return g; };
  if (!same(geoRest(b), geoRest(after))) out.push("autres lieux modifiés");
  const listDiff = (key: string, label: string) => {
    const was = ids(b[key]), now = ids(after[key]);
    const wasIds = new Set(was.map((a) => a.id)), nowIds = new Set(now.map((a) => a.id));
    const added = now.filter((a) => !wasIds.has(a.id)).map(audienceName), removed = was.filter((a) => !nowIds.has(a.id)).map(audienceName);
    if (added.length || removed.length) out.push(`${label} ${added.length ? `+ ${added.join(", ")}` : ""}${added.length && removed.length ? " ; " : ""}${removed.length ? `− ${removed.join(", ")}` : ""}`);
  };
  listDiff("custom_audiences", "audiences");
  listDiff("excluded_custom_audiences", "exclusions");
  const pOf = (t: Targeting) => (Array.isArray(t.publisher_platforms) && t.publisher_platforms.length ? (t.publisher_platforms as string[]).map((p) => PLATFORM_FR_META[p] ?? p).join(", ") : "automatiques");
  if (pOf(b) !== pOf(after)) out.push(`placements ${pOf(b)} → ${pOf(after)}`);
  const aOf = (t: Targeting) => ((t.targeting_automation as Record<string, unknown> | undefined)?.advantage_audience === 1 ? "activée" : "désactivée");
  if (aOf(b) !== aOf(after)) out.push(`audience Advantage+ ${aOf(b)} → ${aOf(after)}`);
  if (!same(b.flexible_spec, after.flexible_spec) || !same(b.exclusions, after.exclusions)) out.push("intérêts / comportements modifiés");
  const known = new Set(["age_min", "age_max", "genders", "geo_locations", "custom_audiences", "excluded_custom_audiences", "publisher_platforms", "facebook_positions", "instagram_positions", "messenger_positions", "audience_network_positions", "threads_positions", "targeting_automation", "flexible_spec", "exclusions"]);
  const otherKeys = [...new Set([...Object.keys(b), ...Object.keys(after)])].filter((k) => !known.has(k) && !same(b[k], after[k]));
  if (otherKeys.length) out.push(`autres réglages modifiés : ${otherKeys.join(", ")}`);
  return out.length ? out : (same(b, after) ? [] : ["ciblage modifié"]);
}

/** The edits as the current spec holds them (what the editor starts from). */
export function editsOf(t: Targeting): Required<Omit<TargetingEdits, "publisherPlatforms">> & { publisherPlatforms: string[] | null } {
  const geo = (t.geo_locations ?? {}) as Record<string, unknown>;
  return {
    ageMin: typeof t.age_min === "number" ? t.age_min : 18,
    ageMax: typeof t.age_max === "number" ? t.age_max : 65,
    genders: Array.isArray(t.genders) ? (t.genders as number[]) : [],
    countries: Array.isArray(geo.countries) ? (geo.countries as string[]) : [],
    customAudiences: ids(t.custom_audiences).map((a) => a.id),
    excludedCustomAudiences: ids(t.excluded_custom_audiences).map((a) => a.id),
    publisherPlatforms: Array.isArray(t.publisher_platforms) && t.publisher_platforms.length ? (t.publisher_platforms as string[]) : null,
    advantageAudience: (t.targeting_automation as Record<string, unknown> | undefined)?.advantage_audience === 1,
  };
}
