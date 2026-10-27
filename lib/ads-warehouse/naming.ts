/**
 * Naming-convention tags — Motion's "automatic tagging from ad names".
 *
 * Supported syntaxes, mixed freely inside one name:
 *   key:value pairs       "c:Lavender_f:Video_o:BOGO"  → { c: "Lavender", f: "Video", o: "BOGO" }
 *   key=value             "angle=Price | format=UGC"   → { angle: "Price", format: "UGC" }
 *   KEY-Value (short key) "SGL_IMG_S-Pulse_V-CAD_M-Autorité_M-SurMesure" → { s: "Pulse", v: "CAD", m: "Autorité | SurMesure", s1: "SGL", s2: "IMG" }
 *                          (the agency's own convention: a key of 1-4 letters, a dash, a value; repeated keys are joined)
 *   bracketed tokens      "[UGC][Promo] Summer"         → { t1: "UGC", t2: "Promo" }
 *   plain segments        "UGC_Hook3_Promo_FR"           → { s1: "UGC", s2: "Hook3", s3: "Promo", s4: "FR" }
 * Separators: "_", "|", " - ", " / ". Values keep their case; keys are lowercased.
 * Plain segments are only kept when the name has 2..8 segments and no key:value
 * pair (otherwise the pairs are the convention and the rest is free text).
 */

const SEP = /\s*(?:_|\||\s-\s|\s\/\s|\[|\])\s*/;
const PAIR = /^([A-Za-z][A-Za-z0-9]{0,24})\s*[:=]\s*(.+)$/;
const DASH_PAIR = /^([A-Za-z][A-Za-z0-9]{0,4})-(.+)$/;
const BRACKET = /\[([^\]]{1,40})\]/g;

export function parseNamingTags(name: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!name) return out;
  const trimmed = name.trim();
  if (!trimmed) return out;

  // "[UGC][Promo] Summer" → t1, t2 ; but "[g-desti_ca1-maroc_m-experience]" is a
  // convention block (keys inside): it is split like the rest of the name.
  let i = 0;
  const isBlock = (inner: string) => /[_|]/.test(inner) || /^[A-Za-z][A-Za-z0-9]{0,4}[-:=]/.test(inner);
  for (const m of trimmed.matchAll(BRACKET)) {
    if (isBlock(m[1])) continue;
    i += 1;
    out[`t${i}`] = m[1].trim();
  }
  const rest = trimmed.replace(BRACKET, (m, inner: string) => (isBlock(inner) ? ` ${inner} ` : " ")).trim();
  const segments = rest.split(SEP).map((s) => s.trim()).filter(Boolean);
  const pairs: Array<[string, string]> = [];
  const loose: string[] = [];
  for (const seg of segments) {
    const m = seg.match(PAIR);
    if (m && !/^https?$/i.test(m[1])) { pairs.push([m[1].toLowerCase(), m[2].trim()]); continue; }
    const d = seg.match(DASH_PAIR);
    if (d && d[2].trim() && !/^\d+$/.test(d[2])) { pairs.push([d[1].toLowerCase(), d[2].trim()]); continue; }
    loose.push(seg);
  }
  // A convention needs at least two pairs (one lone "X-Y" is just a word with a dash).
  if (pairs.length >= 2 || (pairs.length === 1 && /[:=]/.test(trimmed))) {
    for (const [k, v] of pairs) out[k] = k in out ? `${out[k]} | ${v}` : v;
    loose.slice(0, 8).forEach((s, idx) => { out[`s${idx + 1}`] = s; });
    return out;
  }
  if (segments.length >= 2 && segments.length <= 8 && i === 0) {
    segments.forEach((s, idx) => { out[`s${idx + 1}`] = s; });
  }
  return out;
}

/** Keys that look like a real convention (not positional fallbacks). */
export function conventionKeys(tags: Record<string, string>): string[] {
  return Object.keys(tags).filter((k) => !/^(s|t)\d+$/.test(k));
}
