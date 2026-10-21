/**
 * Sources d'un dashboard du staff : ce que le consultant COCHE à la création
 * (« Google Ads, Meta, TikTok… ») et les comptes retenus pour chacune. Elles
 * sont gardées sur le dashboard, montrées en tête de page, et données au
 * copilote à chaque tour : il construit ses jeux de données sur ces comptes-là,
 * sans que le consultant ait à recopier des identifiants dans le brief.
 *
 * Sans dépendance : importé par le navigateur (sélecteur, propositions) et
 * par le serveur (validation, prompt).
 */

export type SourceKind = "google" | "meta" | "tiktok" | "ga4" | "sheets" | "merchant" | "magento" | "warehouse" | "drive";

export interface SourceAccount {
  /** Identifiant tel que l'outil l'attend (customer_id sans tirets, act_…, advertiser_id). */
  id: string;
  name: string;
}

export interface StaffSource {
  kind: SourceKind;
  /** Comptes retenus (plateformes publicitaires, entrepôts) ; vide = « à trouver avec les outils ». */
  accounts: SourceAccount[];
  /** Précision libre : lien + onglet d'un Sheet, identifiant de propriété GA4, nom de fichier Drive… */
  detail: string;
}

export interface SourceKindInfo {
  kind: SourceKind;
  label: string;
  /** Nom du connecteur tel que le copilote doit l'écrire dans un jeu de données. */
  connector: string | null;
  /** Plateforme des comptes proposés au choix (/api/staff-dashboards/sources), ou null. */
  accountPlatform: "meta" | "google" | "tiktok" | "warehouse" | null;
  /** Aide affichée au consultant. */
  hint: string;
  /** Exemple d'identifiant saisi à la main. */
  idPlaceholder: string | null;
  /** Précision attendue (libellé du champ), ou null. */
  detailLabel: string | null;
}

export const SOURCE_KINDS: SourceKindInfo[] = [
  { kind: "google", label: "Google Ads", connector: "n8n google ads", accountPlatform: "google", hint: "Comptes client Google Ads (identifiant à 10 chiffres).", idPlaceholder: "1234567890", detailLabel: null },
  { kind: "meta", label: "Meta Ads", connector: "mcp facebook", accountPlatform: "meta", hint: "Comptes publicitaires Meta (act_…).", idPlaceholder: "act_123456789", detailLabel: null },
  { kind: "tiktok", label: "TikTok Ads", connector: "tiktok", accountPlatform: "tiktok", hint: "Annonceurs TikTok lisibles par les Business Centers de l'agence.", idPlaceholder: "7012345678901234567", detailLabel: null },
  { kind: "ga4", label: "Google Analytics 4", connector: "ga4", accountPlatform: null, hint: "Propriété GA4 à lire (identifiant numérique de la propriété).", idPlaceholder: null, detailLabel: "Identifiant de propriété (ou nom du site)" },
  { kind: "sheets", label: "Google Sheets", connector: "n8n google spreedsheet", accountPlatform: null, hint: "Classeur partagé avec data@impulse-analytics.com : lien + nom de l'onglet.", idPlaceholder: null, detailLabel: "Lien du classeur et onglet(s)" },
  { kind: "merchant", label: "Merchant Center", connector: "merchant", accountPlatform: null, hint: "Compte Merchant Center du client (identifiant marchand).", idPlaceholder: null, detailLabel: "Identifiant marchand (facultatif)" },
  { kind: "warehouse", label: "Entrepôt e-commerce", connector: null, accountPlatform: "warehouse", hint: "Commandes et fichiers déposés des clients dont l'entrepôt est alimenté (outils data_*).", idPlaceholder: null, detailLabel: null },
  { kind: "magento", label: "Magento LPEV", connector: "magento", accountPlatform: null, hint: "Boutique lpev.fr en direct (commandes, produits, prescripteurs).", idPlaceholder: null, detailLabel: null },
  { kind: "drive", label: "Fichiers Drive", connector: null, accountPlatform: null, hint: "CSV, Excel ou Sheets déposés dans le dossier Drive des dashboards.", idPlaceholder: null, detailLabel: "Nom(s) de fichier ou lien Drive" },
];

const KINDS = new Set<string>(SOURCE_KINDS.map((k) => k.kind));
export const MAX_SOURCE_ACCOUNTS = 40;
const MAX_DETAIL_CHARS = 600;
const MAX_ACCOUNT_ID_CHARS = 80;
const MAX_ACCOUNT_NAME_CHARS = 120;

export function sourceKindInfo(kind: SourceKind): SourceKindInfo {
  return SOURCE_KINDS.find((k) => k.kind === kind) ?? SOURCE_KINDS[0];
}

function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

/** Identifiant tel que les outils l'attendent : Google sans tirets, Meta avec act_, TikTok tel quel. */
export function normalizeSourceAccountId(kind: SourceKind, raw: string): string {
  const id = raw.trim();
  if (kind === "google") return id.replace(/-/g, "");
  if (kind === "meta") return /^\d+$/.test(id) ? `act_${id}` : id;
  return id;
}

/**
 * Lit et nettoie `sourcesJson` (ou la valeur envoyée par le navigateur / l'IA) :
 * une source par type au plus, comptes dédoublonnés, textes bornés. Une entrée
 * illisible est écartée sans erreur : les sources sont une aide, pas un contrat.
 */
export function parseSources(raw: unknown): StaffSource[] {
  let list: unknown = raw;
  if (typeof raw === "string") { try { list = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  const out: StaffSource[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    const kind = typeof s.kind === "string" ? s.kind : "";
    if (!KINDS.has(kind) || seen.has(kind)) continue;
    seen.add(kind);
    const accounts: SourceAccount[] = [];
    const ids = new Set<string>();
    if (Array.isArray(s.accounts)) {
      for (const a of s.accounts) {
        if (accounts.length >= MAX_SOURCE_ACCOUNTS) break;
        const rec = (a && typeof a === "object" ? a : {}) as Record<string, unknown>;
        const rawId = typeof a === "string" ? a : typeof rec.id === "string" ? rec.id : typeof rec.accountId === "string" ? rec.accountId : "";
        const id = normalizeSourceAccountId(kind as SourceKind, cleanText(rawId, MAX_ACCOUNT_ID_CHARS));
        if (!id || ids.has(id)) continue;
        ids.add(id);
        accounts.push({ id, name: cleanText(rec.name, MAX_ACCOUNT_NAME_CHARS) || id });
      }
    }
    out.push({ kind: kind as SourceKind, accounts, detail: cleanText(s.detail, MAX_DETAIL_CHARS) });
  }
  return out;
}

/** Libellé court d'une source (pastilles) : « Google Ads · 2 comptes ». */
export function sourceSummary(s: StaffSource): string {
  const info = sourceKindInfo(s.kind);
  if (s.accounts.length === 1) return `${info.label} · ${s.accounts[0].name}`;
  if (s.accounts.length > 1) return `${info.label} · ${s.accounts.length} comptes`;
  return info.label;
}

/**
 * Le paragraphe donné au copilote (état du dashboard) : sources cochées, comptes
 * et précisions, avec le nom de connecteur à écrire dans les jeux de données.
 */
export function sourcesContextText(sources: StaffSource[]): string {
  if (!sources.length) return "Sources choisies par le consultant : (aucune — demande-lui les comptes ou trouve-les avec tes outils)";
  const lines = sources.map((s) => {
    const info = sourceKindInfo(s.kind);
    const parts: string[] = [];
    if (s.accounts.length) parts.push(`comptes : ${s.accounts.map((a) => (a.name && a.name !== a.id ? `${a.name} (${a.id})` : a.id)).join(", ")}`);
    if (s.detail) parts.push(`précision : ${s.detail}`);
    if (info.connector) parts.push(`connector "${info.connector}"`);
    else if (s.kind === "warehouse") parts.push("outils data_* (clé client = l'identifiant donné)");
    else if (s.kind === "drive") parts.push("dossier Drive des dashboards (gws_*)");
    return `- ${info.label}${parts.length ? ` — ${parts.join(" ; ")}` : ""}`;
  });
  return `Sources choisies par le consultant (construis les jeux de données sur CES comptes ; n'en cherche pas d'autres sans qu'il le demande) :\n${lines.join("\n")}`;
}
