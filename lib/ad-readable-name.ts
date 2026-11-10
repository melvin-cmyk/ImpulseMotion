/**
 * A name a client can read, from an ad named with the agency's convention:
 *   W45Y26_SGL_IMG_b-brand_g-sport-desti_sp-trek_de-capvert_th-solo_pc-solo_co-promessespot_m-paysages_f-story_…
 *   → « Trek · Cap-Vert · Solo · Promessespot »
 * The values of the « key-value » segments, in the order of the name, without
 * the technical keys (brand, landing page, iteration, visual, format, hook) nor
 * the catch-all values (« all »), five at most. A name that does not follow the
 * convention (fewer than two pairs) is returned as it is. Pure: used by the
 * bot's prompt block (server) and by the creative cards (browser).
 */

const PAIR = /^([A-Za-z][A-Za-z0-9]{0,4})-(.+)$/;
/** Keys that say how the ad is built, not what it shows. */
const TECHNICAL = new Set(["b", "g", "lp", "it", "i", "f", "ho"]);
const SKIPPED_VALUES = new Set(["all", "tous", "na", "none", "x"]);
/** Values written in one word in ad names. */
const ALIASES: Record<string, string> = {
  capvert: "Cap-Vert", nouvelan: "Nouvel an", earlybird: "Early bird", reveillon: "Réveillon", multihiver: "Multi-activités hiver",
  multiete: "Multi-activités été", generique: "Générique", blackfriday: "Black Friday", noel: "Noël", ete: "Été", etatsunis: "États-Unis",
  nepal: "Népal", perou: "Pérou", velo: "Vélo", randonnee: "Randonnée", montblanc: "Mont-Blanc", lareunion: "La Réunion", costarica: "Costa Rica",
};
const MAX_PARTS = 5;

function humanize(value: string): string {
  const v = value.trim();
  const alias = ALIASES[v.toLowerCase()];
  if (alias) return alias;
  const spaced = v.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function readableAdName(name: string | null | undefined): string {
  const raw = (name ?? "").trim();
  if (!raw) return "";
  const parts: string[] = [];
  let pairs = 0;
  for (const seg of raw.replace(/[[\]]/g, "_").split(/\s*(?:_|\|)\s*/)) {
    const m = PAIR.exec(seg.trim());
    if (!m || /^\d+$/.test(m[2])) continue;
    pairs += 1;
    const key = m[1].toLowerCase(), value = m[2].trim();
    if (TECHNICAL.has(key) || SKIPPED_VALUES.has(value.toLowerCase())) continue;
    const text = humanize(value);
    if (!parts.some((p) => p.toLowerCase() === text.toLowerCase())) parts.push(text);
  }
  if (pairs < 2 || !parts.length) return raw;
  return parts.slice(0, MAX_PARTS).join(" · ");
}
