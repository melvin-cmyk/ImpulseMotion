/**
 * Global Cockpit — the agency budget sheet (Google Sheets, read as CSV).
 *
 * The sheet is the registry of clients: one line per client × country ×
 * platform × month, with the monthly budget and, when the consultant filled
 * them, the ROAS / CPL targets. Columns (header row):
 *   Client | Team | Country / Region | Platform | Currency | Mois | Budget |
 *   Target ROAS | Target CPL | …
 *
 * Only Meta (« FB/IG ») and Google lines feed the cockpit: the other
 * platforms have no data source here. Lines of the same brand
 * (« LPEV ACQ », « LPEV Traffic ») are one client.
 *
 * Pure parsing below; `fetchBudgetSheet` is the only I/O.
 */

export const BUDGET_SHEET_ID = process.env.COCKPIT_SHEET_ID || "1oj4ZZnxCNHWdR56XDH7NhiqiNYm2ia8Xoq5EOkpt6rs";
export const BUDGET_SHEET_GID = process.env.COCKPIT_SHEET_GID || "952272258";

export type SheetPlatform = "meta" | "google" | "other";

export interface SheetLine {
  client: string;
  team: string | null;
  country: string | null;
  platform: SheetPlatform;
  platformRaw: string;
  currency: string | null;
  /** YYYY-MM */
  month: string;
  budget: number | null;
  targetRoas: number | null;
  targetCpl: number | null;
}

export interface SheetClient {
  /** stable key: normalized brand ("lpev", "cours-legendre") */
  key: string;
  name: string;
  /** names of the sheet that make this client */
  sheetNames: string[];
  team: string | null;
  currency: string | null;
  /** budget of the month, per platform, in the sheet currency (null = not filled) */
  budget: { meta: number | null; google: number | null };
  /** latest target found in the sheet, whatever the month */
  targetRoas: number | null;
  targetCpl: number | null;
  /** lines of the month on platforms the cockpit cannot read (LinkedIn, TikTok…) */
  otherPlatforms: string[];
}

/** RFC 4180 CSV → rows (quoted fields, escaped quotes, newlines in fields). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** "€3,000" · "R5,400,000.00" · "$70,000" · "1 200,50 €" → number; blank → null. */
export function parseAmount(raw: string | undefined): number | null {
  const s = (raw ?? "").replace(/[^\d.,-]/g, "");
  if (!s || !/\d/.test(s)) return null;
  let t = s;
  const lastDot = t.lastIndexOf("."), lastComma = t.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // The last separator is the decimal one.
    t = lastDot > lastComma ? t.replace(/,/g, "") : t.replace(/\./g, "").replace(",", ".");
  } else if (lastComma >= 0) {
    // "3,000" is thousands; "12,5" is a decimal.
    t = /,\d{3}(,|$)/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
};

/** "01/September/2026" → "2026-09"; "01/09/2026" → "2026-09". */
export function parseMonth(raw: string | undefined): string | null {
  const m = /^\s*\d{1,2}\/([A-Za-z]+|\d{1,2})\/(\d{4})\s*$/.exec(raw ?? "");
  if (!m) return null;
  const mm = /^\d+$/.test(m[1]) ? m[1].padStart(2, "0") : MONTHS[m[1].toLowerCase()];
  return mm ? `${m[2]}-${mm}` : null;
}

export function parsePlatform(raw: string | undefined): SheetPlatform {
  const p = (raw ?? "").trim().toLowerCase();
  if (p === "fb/ig" || p === "meta" || p === "facebook") return "meta";
  if (p.startsWith("google")) return "google";
  return "other";
}

export function normalizeName(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

const LEADING = new Set(["la", "le", "les", "the"]);

/** Brand token that groups the lines of one client ("LPEV ACQ" → "lpev"). */
export function brandToken(name: string): string {
  const tokens = normalizeName(name).split(" ").filter(Boolean);
  while (tokens.length > 1 && LEADING.has(tokens[0])) tokens.shift();
  return tokens[0] ?? "";
}

/** Words shared by the start of every name of the group ("Cours Legendre - EAD", … → "Cours Legendre"). */
export function commonName(names: string[]): string {
  if (!names.length) return "";
  const split = names.map((n) => n.trim().split(/\s+/));
  const out: string[] = [];
  for (let i = 0; i < split[0].length; i++) {
    const w = split[0][i];
    if (split.every((s) => s[i] !== undefined && normalizeName(s[i]) === normalizeName(w))) out.push(w);
    else break;
  }
  const name = out.join(" ").replace(/[\s\-–(/]+$/, "").trim();
  return name || names[0].trim();
}

export function parseBudgetSheet(csv: string): SheetLine[] {
  const rows = parseCsv(csv);
  const header = rows.findIndex((r) => r.some((c) => c.trim().toLowerCase() === "client") && r.some((c) => c.trim().toLowerCase() === "budget"));
  if (header < 0) throw new Error("Feuille budgets : en-tête introuvable (colonnes « Client » et « Budget »)");
  const col = (label: string) => rows[header].findIndex((c) => c.trim().toLowerCase().startsWith(label));
  const idx = {
    client: col("client"), team: col("team"), country: col("country"), platform: col("platform"),
    currency: col("currency"), month: col("mois"), budget: col("budget"), roas: col("target roas"), cpl: col("target cpl"),
  };
  if (idx.platform < 0 || idx.month < 0) throw new Error("Feuille budgets : colonnes « Platform » ou « Mois » introuvables");

  const lines: SheetLine[] = [];
  for (const r of rows.slice(header + 1)) {
    const client = (r[idx.client] ?? "").trim();
    const month = parseMonth(r[idx.month]);
    if (!client || !month) continue;
    const team = (r[idx.team] ?? "").trim();
    lines.push({
      client,
      team: team && !team.startsWith("#") ? team : null,
      country: (r[idx.country] ?? "").trim() || null,
      platform: parsePlatform(r[idx.platform]),
      platformRaw: (r[idx.platform] ?? "").trim(),
      currency: (r[idx.currency] ?? "").trim().toUpperCase() || null,
      month,
      budget: parseAmount(r[idx.budget]),
      targetRoas: idx.roas >= 0 ? parseAmount(r[idx.roas]) : null,
      targetCpl: idx.cpl >= 0 ? parseAmount(r[idx.cpl]) : null,
    });
  }
  return lines;
}

/** Clients of a month, with their budgets and the latest known targets. */
export function sheetClients(lines: SheetLine[], month: string): SheetClient[] {
  const groups = new Map<string, SheetLine[]>();
  for (const l of lines) {
    if (l.month !== month) continue;
    const key = brandToken(l.client);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }

  // Targets are often filled once and not repeated: take the latest month that has one.
  const latest = new Map<string, { roas: { month: string; v: number } | null; cpl: { month: string; v: number } | null }>();
  for (const l of lines) {
    if (l.month > month) continue;
    const key = brandToken(l.client);
    const cur = latest.get(key) ?? { roas: null, cpl: null };
    if (l.targetRoas && (!cur.roas || l.month > cur.roas.month)) cur.roas = { month: l.month, v: l.targetRoas };
    if (l.targetCpl && (!cur.cpl || l.month > cur.cpl.month)) cur.cpl = { month: l.month, v: l.targetCpl };
    latest.set(key, cur);
  }

  const out: SheetClient[] = [];
  for (const [key, ls] of groups) {
    const names = [...new Set(ls.map((l) => l.client))];
    const budgetOf = (p: SheetPlatform) => {
      const filled = ls.filter((l) => l.platform === p && l.budget !== null);
      return filled.length ? filled.reduce((s, l) => s + (l.budget ?? 0), 0) : null;
    };
    const t = latest.get(key);
    out.push({
      key,
      name: commonName(names),
      sheetNames: names,
      team: ls.find((l) => l.team)?.team ?? null,
      currency: ls.find((l) => l.currency)?.currency ?? null,
      budget: { meta: budgetOf("meta"), google: budgetOf("google") },
      targetRoas: t?.roas?.v ?? null,
      targetCpl: t?.cpl?.v ?? null,
      otherPlatforms: [...new Set(ls.filter((l) => l.platform === "other" && l.budget).map((l) => l.platformRaw))],
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

export function budgetSheetUrl(): string {
  return `https://docs.google.com/spreadsheets/d/${BUDGET_SHEET_ID}/export?format=csv&gid=${BUDGET_SHEET_GID}`;
}

/** Reads the sheet through its link export (the sheet is shared by link). */
export async function fetchBudgetSheet(): Promise<SheetLine[]> {
  const res = await fetch(budgetSheetUrl(), { redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.includes("csv")) {
    throw new Error(`Feuille budgets illisible (HTTP ${res.status}) — vérifiez qu'elle est partagée « toute personne disposant du lien »`);
  }
  return parseBudgetSheet(await res.text());
}
