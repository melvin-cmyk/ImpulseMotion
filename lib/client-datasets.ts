/**
 * Jeux de données déposés pour un bot client (entrepôt client_data).
 *
 * Un consultant dépose un CSV / XLSX / Google Sheet dans le dossier Drive du
 * client ; n8n (flux « Bots clients → Fichiers de données ») lit le fichier et
 * envoie ses lignes à POST /api/ingest/files par lots. Ici :
 *   - les helpers purs (clé de jeu, normalisation des cellules, typage des
 *     colonnes, lecture d'un identifiant de dossier Drive) ;
 *   - les écritures dans l'entrepôt (lots → chargement → bascule atomique) ;
 *   - les lectures pour le prompt du bot et la fiche admin.
 *
 * Le client_key vient toujours du bot retrouvé par son dossier Drive, jamais du
 * corps de la requête. Les lignes sont stockées en jsonb, les colonnes typées
 * (text | number | date) à la fin du chargement sur un échantillon.
 */

import { getClientDataPool } from "@/lib/client-data";

export type ColumnType = "text" | "number" | "date";
export interface DatasetColumn {
  name: string;
  type: ColumnType;
  /** Première valeur non vide rencontrée (aide le modèle à comprendre la colonne). */
  sample?: string | null;
}

export interface DatasetSource {
  driveFileId?: string;
  fileName?: string;
  mimeType?: string;
  modifiedTime?: string;
  folderId?: string;
}

export interface DatasetSummary {
  clientKey: string;
  datasetKey: string;
  name: string;
  description: string | null;
  columns: DatasetColumn[];
  rowCount: number;
  source: DatasetSource;
  lastError: string | null;
  loadedAt: string | null;
  updatedAt: string | null;
}

export const MAX_ROWS_PER_PART = 2000;
export const MAX_COLUMNS = 60;
export const MAX_CELL_CHARS = 2000;
export const MAX_ROWS_PER_DATASET = 200_000;

// ── Helpers purs ────────────────────────────────────────────────────────────

/** Nom de fichier → clé de jeu (slug) : « Ventes Magasins 2025.csv » → « ventes-magasins-2025 ». */
export function datasetKeyFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[a-z0-9]{1,6}$/i, "");
  const slug = base
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length >= 1 ? slug : "fichier";
}

/** Nom lisible d'un jeu : le nom de fichier sans extension, espaces normalisés. */
export function datasetNameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[a-z0-9]{1,6}$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return (base || fileName).slice(0, 120);
}

/** Identifiant de dossier Drive depuis un lien ou un identifiant brut ; null si illisible. */
export function parseDriveFolderId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) ?? s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  const id = m ? m[1] : s;
  return /^[A-Za-z0-9_-]{10,128}$/.test(id) ? id : null;
}

/** Nom de colonne normalisé : trim, espaces internes réduits, 64 caractères, jamais vide. */
export function normalizeColumnName(raw: unknown, index: number): string {
  const s = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return (s || `colonne_${index + 1}`).slice(0, 64);
}

const NUM_FR_RE = /^-?\d{1,3}(?:[\s .]\d{3})*(?:,\d+)?$/; // 1 234,56 ou 1.234,56
const NUM_EN_RE = /^-?\d+(?:\.\d+)?$/; // 1234.56
const NUM_EN_GROUPED_RE = /^-?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/; // 1,234.56
const DATE_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/;
const DATE_FR_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s.*)?$/;

/**
 * Normalise une cellule telle que lue par n8n :
 *  - nombres écrits à la française (1 234,56 ; 12,5 ; 12 €) → nombre ;
 *  - dates dd/mm/yyyy → yyyy-mm-dd (les dates ISO gardent leurs 10 premiers caractères) ;
 *  - chaînes vides / null → null ; le reste → texte tronqué.
 */
export function coerceCell(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v !== "string") return String(v).slice(0, MAX_CELL_CHARS);
  const s = v.trim();
  if (!s) return null;
  const iso = s.match(DATE_ISO_RE);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const fr = s.match(DATE_FR_RE);
  if (fr) {
    const d = Number(fr[1]), m = Number(fr[2]);
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) return `${fr[3]}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const numeric = s.replace(/\s?(€|eur|%|\$)$/i, "").trim();
  if (NUM_EN_RE.test(numeric)) return Number(numeric);
  if (NUM_EN_GROUPED_RE.test(numeric)) return Number(numeric.replace(/,/g, ""));
  if (NUM_FR_RE.test(numeric)) return Number(numeric.replace(/[\s .]/g, "").replace(",", "."));
  return s.slice(0, MAX_CELL_CHARS);
}

/** Normalise une ligne reçue (objet colonne → valeur) sur les colonnes déclarées. */
export function normalizeRow(raw: Record<string, unknown>, columns: string[]): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const name of columns) {
    const key = Object.prototype.hasOwnProperty.call(raw, name) ? name : Object.keys(raw).find((k) => k.trim() === name);
    out[name] = key !== undefined ? coerceCell(raw[key]) : null;
  }
  return out;
}

/**
 * Type de chaque colonne d'après un échantillon de lignes NORMALISÉES :
 * number si ≥ 90 % des valeurs non vides sont des nombres, date si ≥ 90 %
 * sont des dates ISO, sinon text. Une colonne vide est text.
 */
export function inferColumns(names: string[], sample: Record<string, unknown>[]): DatasetColumn[] {
  return names.map((name) => {
    let nums = 0, dates = 0, filled = 0;
    let first: string | null = null;
    for (const row of sample) {
      const v = row[name];
      if (v === null || v === undefined || v === "") continue;
      filled++;
      if (first === null) first = String(v).slice(0, 40);
      if (typeof v === "number") nums++;
      else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) dates++;
    }
    let type: ColumnType = "text";
    if (filled && nums / filled >= 0.9) type = "number";
    else if (filled && dates / filled >= 0.9) type = "date";
    return { name, type, sample: first };
  });
}

// ── Lectures ────────────────────────────────────────────────────────────────

type DatasetRow = {
  client_key: string; dataset_key: string; name: string; description: string | null; columns: unknown;
  row_count: number; source: unknown; last_error: string | null; loaded_at: Date | null; updated_at: Date | null;
  current_load_id: string | null;
};

function toSummary(r: DatasetRow): DatasetSummary {
  return {
    clientKey: r.client_key,
    datasetKey: r.dataset_key,
    name: r.name,
    description: r.description,
    columns: Array.isArray(r.columns) ? (r.columns as DatasetColumn[]) : [],
    rowCount: Number(r.row_count ?? 0),
    source: r.source && typeof r.source === "object" ? (r.source as DatasetSource) : {},
    lastError: r.last_error,
    loadedAt: r.loaded_at ? new Date(r.loaded_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

/** Jeux de données d'un client (chargés ou non), les plus récents en premier. */
export async function listDatasets(clientKey: string): Promise<DatasetSummary[]> {
  const pool = getClientDataPool();
  const { rows } = await pool.query<DatasetRow>(
    `SELECT client_key, dataset_key, name, description, columns, row_count, source, last_error, loaded_at, updated_at, current_load_id
     FROM client_data.datasets WHERE client_key = $1 ORDER BY loaded_at DESC NULLS LAST, name ASC`,
    [clientKey],
  );
  return rows.map(toSummary);
}

/** Fichiers Drive déjà chargés par client : { driveFileId → modifiedTime } (pour que n8n ne recharge que ce qui a changé). */
export async function knownFilesByClient(clientKeys: string[]): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  if (!clientKeys.length) return out;
  const pool = getClientDataPool();
  const { rows } = await pool.query<{ client_key: string; source: DatasetSource | null; current_load_id: string | null }>(
    `SELECT client_key, source, current_load_id FROM client_data.datasets WHERE client_key = ANY($1::text[])`,
    [clientKeys],
  );
  for (const r of rows) {
    if (!r.current_load_id || !r.source?.driveFileId || !r.source.modifiedTime) continue;
    (out[r.client_key] ??= {})[r.source.driveFileId] = r.source.modifiedTime;
  }
  return out;
}

// ── Écritures ───────────────────────────────────────────────────────────────

export interface DatasetPart {
  clientKey: string;
  datasetKey: string;
  name: string;
  source: DatasetSource;
  loadId: string;
  /** Décalage de la première ligne de ce lot dans le fichier (0 pour le premier lot). */
  rowOffset: number;
  columns: string[];
  rows: Record<string, unknown>[];
  /** true sur le dernier lot : le chargement devient visible. */
  final: boolean;
}

export interface DatasetPartResult {
  rowsWritten: number;
  finalized: boolean;
  rowCount?: number;
  columns?: DatasetColumn[];
}

/**
 * Écrit un lot de lignes d'un chargement puis, si c'est le dernier, bascule le
 * jeu dessus (colonnes typées, compteur, source) et supprime les lignes des
 * autres chargements. Idempotent par (load_id, row_no).
 */
export async function writeDatasetPart(part: DatasetPart): Promise<DatasetPartResult> {
  const pool = getClientDataPool();
  const columns = part.columns.map((c, i) => normalizeColumnName(c, i)).slice(0, MAX_COLUMNS);
  const normalized = part.rows.map((r) => normalizeRow(r, columns));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO client_data.datasets (client_key, dataset_key, name, columns, source, updated_at)
       VALUES ($1, $2, $3, '[]'::jsonb, $4::jsonb, now())
       ON CONFLICT (client_key, dataset_key) DO UPDATE SET updated_at = now()`,
      [part.clientKey, part.datasetKey, part.name, JSON.stringify(part.source)],
    );
    if (normalized.length) {
      const rowNos = normalized.map((_, i) => part.rowOffset + i);
      await client.query(
        `INSERT INTO client_data.dataset_rows (client_key, dataset_key, load_id, row_no, data)
         SELECT $1, $2, $3, t.row_no, t.data::jsonb
         FROM unnest($4::int[], $5::text[]) AS t(row_no, data)
         ON CONFLICT (client_key, dataset_key, load_id, row_no) DO UPDATE SET data = EXCLUDED.data`,
        [part.clientKey, part.datasetKey, part.loadId, rowNos, normalized.map((r) => JSON.stringify(r))],
      );
    }
    let result: DatasetPartResult = { rowsWritten: normalized.length, finalized: false };
    if (part.final) {
      const { rows: sample } = await client.query<{ data: Record<string, unknown> }>(
        `SELECT data FROM client_data.dataset_rows WHERE client_key = $1 AND dataset_key = $2 AND load_id = $3 ORDER BY row_no LIMIT 1000`,
        [part.clientKey, part.datasetKey, part.loadId],
      );
      const { rows: cnt } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM client_data.dataset_rows WHERE client_key = $1 AND dataset_key = $2 AND load_id = $3`,
        [part.clientKey, part.datasetKey, part.loadId],
      );
      const typed = inferColumns(columns, sample.map((s) => s.data));
      const rowCount = Number(cnt[0]?.n ?? 0);
      await client.query(
        `UPDATE client_data.datasets
         SET name = $3, columns = $4::jsonb, row_count = $5, current_load_id = $6, source = $7::jsonb,
             last_error = NULL, loaded_at = now(), updated_at = now()
         WHERE client_key = $1 AND dataset_key = $2`,
        [part.clientKey, part.datasetKey, part.name, JSON.stringify(typed), rowCount, part.loadId, JSON.stringify(part.source)],
      );
      await client.query(
        `DELETE FROM client_data.dataset_rows WHERE client_key = $1 AND dataset_key = $2 AND load_id <> $3`,
        [part.clientKey, part.datasetKey, part.loadId],
      );
      result = { rowsWritten: normalized.length, finalized: true, rowCount, columns: typed };
    }
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Note une erreur de chargement sur un jeu (fichier illisible côté n8n, par exemple). */
export async function recordDatasetError(clientKey: string, datasetKey: string, name: string, source: DatasetSource, error: string): Promise<void> {
  const pool = getClientDataPool();
  await pool.query(
    `INSERT INTO client_data.datasets (client_key, dataset_key, name, source, last_error, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, now())
     ON CONFLICT (client_key, dataset_key) DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = now()`,
    [clientKey, datasetKey, name, JSON.stringify(source), error.slice(0, 500)],
  );
}

export async function updateDatasetDescription(clientKey: string, datasetKey: string, description: string | null): Promise<boolean> {
  const pool = getClientDataPool();
  const res = await pool.query(
    `UPDATE client_data.datasets SET description = $3, updated_at = now() WHERE client_key = $1 AND dataset_key = $2`,
    [clientKey, datasetKey, description?.trim() ? description.trim().slice(0, 1000) : null],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Supprime un jeu et toutes ses lignes. Le fichier Drive, lui, reste : n8n le rechargera s'il change. */
export async function deleteDataset(clientKey: string, datasetKey: string): Promise<boolean> {
  const pool = getClientDataPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM client_data.dataset_rows WHERE client_key = $1 AND dataset_key = $2`, [clientKey, datasetKey]);
    const res = await client.query(`DELETE FROM client_data.datasets WHERE client_key = $1 AND dataset_key = $2`, [clientKey, datasetKey]);
    await client.query("COMMIT");
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
