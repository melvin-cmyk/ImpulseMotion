/**
 * Fichiers de données des bots clients : helpers purs (clé, cellules, types,
 * dossier Drive), écriture par lots dans l'entrepôt, et le requêteur SQL
 * partagé avec le serveur MCP (server/dataset-query.mjs).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: { text: string; values?: unknown[] }[] = [];
const state = vi.hoisted(() => ({ nextRows: [] as unknown[][] }));

vi.mock("pg", () => {
  class Pool {
    on() { return this; }
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      return { rows: state.nextRows.shift() ?? [], rowCount: 1 };
    }
    async connect() {
      return {
        query: async (text: string, values?: unknown[]) => {
          calls.push({ text, values });
          return { rows: state.nextRows.shift() ?? [], rowCount: 1 };
        },
        release: () => undefined,
      };
    }
  }
  return { Pool, default: { Pool } };
});

import {
  coerceCell, datasetKeyFromFileName, datasetNameFromFileName, inferColumns, normalizeRow, parseDriveFolderId,
  writeDatasetPart, knownFilesByClient,
} from "@/lib/client-datasets";
import { buildDatasetQuery, aggregateAlias } from "../../server/dataset-query.mjs";

beforeEach(() => {
  calls.length = 0;
  state.nextRows = [];
  process.env.DATA_DATABASE_URL = "postgres://u:p@localhost:5432/db";
});

describe("helpers purs", () => {
  it("clé et nom de jeu depuis le nom de fichier", () => {
    expect(datasetKeyFromFileName("Ventes Magasins 2025.csv")).toBe("ventes-magasins-2025");
    expect(datasetKeyFromFileName("Été_Objectifs (v2).xlsx")).toBe("ete-objectifs-v2");
    expect(datasetKeyFromFileName("....")).toBe("fichier");
    expect(datasetNameFromFileName("ventes_magasins_2025.csv")).toBe("ventes magasins 2025");
    // Google Sheet : pas d'extension
    expect(datasetKeyFromFileName("Objectifs 2026")).toBe("objectifs-2026");
  });

  it("lit un identifiant de dossier Drive depuis un lien ou un identifiant", () => {
    expect(parseDriveFolderId("https://drive.google.com/drive/folders/1yNzDz0Rbo_OMzBrFDnG_pamoMq9J_zuu?usp=sharing")).toBe("1yNzDz0Rbo_OMzBrFDnG_pamoMq9J_zuu");
    expect(parseDriveFolderId("https://drive.google.com/drive/u/0/folders/1yNzDz0Rbo_OMzBrFDnG_pamoMq9J_zuu")).toBe("1yNzDz0Rbo_OMzBrFDnG_pamoMq9J_zuu");
    expect(parseDriveFolderId(" 1yNzDz0Rbo_OMzBrFDnG_pamoMq9J_zuu ")).toBe("1yNzDz0Rbo_OMzBrFDnG_pamoMq9J_zuu");
    expect(parseDriveFolderId("https://drive.google.com/open?id=1yNzDz0Rbo_OMzBrFDnG_pamoMq9J_zuu")).toBe("1yNzDz0Rbo_OMzBrFDnG_pamoMq9J_zuu");
    expect(parseDriveFolderId("pas un id")).toBeNull();
    expect(parseDriveFolderId("")).toBeNull();
    expect(parseDriveFolderId(42)).toBeNull();
  });

  it("normalise les cellules : nombres français, dates, vides", () => {
    expect(coerceCell("1 234,56")).toBe(1234.56);
    expect(coerceCell("1.234,56")).toBe(1234.56);
    expect(coerceCell("1,234.56")).toBe(1234.56);
    expect(coerceCell("12,5 €")).toBe(12.5);
    expect(coerceCell("-3")).toBe(-3);
    expect(coerceCell("42")).toBe(42);
    expect(coerceCell("12/03/2026")).toBe("2026-03-12");
    expect(coerceCell("2026-03-12T10:00:00Z")).toBe("2026-03-12");
    expect(coerceCell("31.12.2025")).toBe("2025-12-31");
    expect(coerceCell("45/13/2025")).toBe("45/13/2025"); // pas une date → texte
    expect(coerceCell("")).toBeNull();
    expect(coerceCell("   ")).toBeNull();
    expect(coerceCell(null)).toBeNull();
    expect(coerceCell(7)).toBe(7);
    expect(coerceCell(true)).toBe(true);
    expect(coerceCell("Paris Nord")).toBe("Paris Nord");
    expect(coerceCell("x".repeat(5000))).toHaveLength(2000);
  });

  it("normalizeRow tolère les en-têtes avec espaces et les colonnes absentes", () => {
    const row = normalizeRow({ " Magasin": "Lyon", "CA HT": "1 000,00" }, ["Magasin", "CA HT", "Marge"]);
    expect(row).toEqual({ Magasin: "Lyon", "CA HT": 1000, Marge: null });
  });

  it("inferColumns : number / date / text à 90 %, avec un exemple", () => {
    const sample = [
      { ca: 10, jour: "2026-01-01", ville: "Lyon", vide: null },
      { ca: 12.5, jour: "2026-01-02", ville: "Paris", vide: null },
      { ca: "n/a", jour: "2026-01-03", ville: "Nice", vide: null },
      ...Array.from({ length: 20 }, (_, i) => ({ ca: i, jour: `2026-02-${String(i + 1).padStart(2, "0")}`, ville: `V${i}`, vide: null })),
    ];
    const cols = inferColumns(["ca", "jour", "ville", "vide"], sample);
    expect(cols.map((c) => c.type)).toEqual(["number", "date", "text", "text"]);
    expect(cols[0].sample).toBe("10");
    expect(cols[3].sample).toBeNull();
  });
});

describe("writeDatasetPart", () => {
  const base = {
    clientKey: "dt", datasetKey: "ventes", name: "ventes",
    source: { driveFileId: "f1", fileName: "ventes.csv", modifiedTime: "2026-10-12T10:00:00Z" },
    loadId: "load-1", columns: ["Magasin", "CA"],
  };

  it("lot intermédiaire : upsert du jeu + lignes, pas de bascule", async () => {
    const res = await writeDatasetPart({ ...base, rowOffset: 0, rows: [{ Magasin: "Lyon", CA: "1 000,00" }, { Magasin: "Paris", CA: "2 000,50" }], final: false });
    expect(res).toEqual({ rowsWritten: 2, finalized: false });
    const texts = calls.map((c) => c.text);
    expect(texts[0]).toBe("BEGIN");
    expect(texts[1]).toContain("INSERT INTO client_data.datasets");
    expect(texts[2]).toContain("INSERT INTO client_data.dataset_rows");
    // lignes normalisées : nombres français → nombres
    const rowsParam = calls[2].values?.[4] as string[];
    expect(JSON.parse(rowsParam[0])).toEqual({ Magasin: "Lyon", CA: 1000 });
    expect(JSON.parse(rowsParam[1])).toEqual({ Magasin: "Paris", CA: 2000.5 });
    expect(calls[2].values?.[3]).toEqual([0, 1]);
    expect(texts.some((t) => t.includes("current_load_id"))).toBe(false);
    expect(texts.at(-1)).toBe("COMMIT");
  });

  it("dernier lot : colonnes typées, compteur, bascule et purge des anciens chargements", async () => {
    // BEGIN, upsert datasets, insert rows, sample, count, update, delete, COMMIT
    state.nextRows = [[], [], [], [{ data: { Magasin: "Lyon", CA: 1000 } }, { data: { Magasin: "Paris", CA: 2000.5 } }], [{ n: 1002 }], [], [], []];
    const res = await writeDatasetPart({ ...base, rowOffset: 1000, rows: [{ Magasin: "Nice", CA: "3" }], final: true });
    expect(res.finalized).toBe(true);
    expect(res.rowCount).toBe(1002);
    expect(res.columns).toEqual([
      { name: "Magasin", type: "text", sample: "Lyon" },
      { name: "CA", type: "number", sample: "1000" },
    ]);
    const update = calls.find((c) => c.text.includes("current_load_id = $6"));
    expect(update?.values?.[5]).toBe("load-1");
    const purge = calls.find((c) => c.text.includes("load_id <> $3"));
    expect(purge?.values).toEqual(["dt", "ventes", "load-1"]);
    expect(calls[2].values?.[3]).toEqual([1000]);
  });

  it("knownFilesByClient ne renvoie que les chargements terminés", async () => {
    state.nextRows = [[
      { client_key: "dt", source: { driveFileId: "f1", modifiedTime: "2026-10-12T10:00:00Z" }, current_load_id: "l1" },
      { client_key: "dt", source: { driveFileId: "f2", modifiedTime: "2026-10-12T11:00:00Z" }, current_load_id: null },
      { client_key: "lpev", source: {}, current_load_id: "l3" },
    ]];
    expect(await knownFilesByClient(["dt", "lpev"])).toEqual({ dt: { f1: "2026-10-12T10:00:00Z" } });
    expect(await knownFilesByClient([])).toEqual({});
  });
});

describe("buildDatasetQuery (server/dataset-query.mjs)", () => {
  const ds = {
    client_key: "dt", dataset_key: "ventes", current_load_id: "l1",
    columns: [{ name: "Magasin", type: "text" }, { name: "CA HT", type: "number" }, { name: "Jour", type: "date" }],
  };

  it("lignes brutes : toutes les colonnes, tri par row_no, limite + 1 pour détecter la suite", () => {
    const q = buildDatasetQuery(ds, {});
    expect(q.aggregated).toBe(false);
    expect(q.columns).toEqual(["Magasin", "CA HT", "Jour"]);
    expect(q.values).toEqual(["dt", "ventes", "l1"]);
    expect(q.text).toContain("r.load_id = $3");
    expect(q.text).toContain("ORDER BY r.row_no ASC LIMIT 21 OFFSET 0");
    expect(q.text).toContain(`(r.data->>'CA HT')::numeric`);
    expect(q.text).toContain(`substr((r.data->>'Jour'), 1, 10)::date`);
  });

  it("agrégats + regroupement + filtres paramétrés + tri sur l'alias", () => {
    const q = buildDatasetQuery(ds, {
      group_by: ["Magasin"],
      aggregates: [{ fn: "sum", column: "CA HT" }, { fn: "count" }],
      where: [{ column: "Jour", op: "gte", value: "2026-01-01" }, { column: "Magasin", op: "contains", value: "ly%" }, { column: "CA HT", op: "in", value: ["1 000,5", 2] }],
      order_by: [{ by: "sum_ca_ht", dir: "desc" }],
      limit: 500,
    });
    expect(q.aggregated).toBe(true);
    expect(q.columns).toEqual(["Magasin", "sum_ca_ht", "count"]);
    expect(q.limit).toBe(200);
    expect(q.text).toContain("GROUP BY 1");
    expect(q.text).toContain(`ORDER BY "sum_ca_ht" DESC NULLS LAST LIMIT 201`);
    expect(q.values).toEqual(["dt", "ventes", "l1", "2026-01-01", "%ly\\%%", ["1000.5", "2"]]);
    expect(q.text).toContain("::date");
    expect(q.text).toContain("ILIKE $5");
    expect(q.text).toContain("= ANY($6::numeric[])");
  });

  it("refuse une colonne inconnue, un opérateur inconnu, une somme sur du texte, un tri hors résultat", () => {
    expect(() => buildDatasetQuery(ds, { select: ["Région"] })).toThrow(/colonne inconnue « Région »/);
    expect(() => buildDatasetQuery(ds, { where: [{ column: "Magasin", op: "like", value: "x" }] })).toThrow(/Opérateur inconnu/);
    expect(() => buildDatasetQuery(ds, { aggregates: [{ fn: "sum", column: "Magasin" }] })).toThrow(/n'est pas numérique/);
    expect(() => buildDatasetQuery(ds, { group_by: ["Magasin"], order_by: [{ by: "Jour" }] })).toThrow(/order_by/);
    expect(() => buildDatasetQuery({ ...ds, current_load_id: null }, {})).toThrow(/chargement terminé/);
  });

  it("tolère la casse d'un nom de colonne et n'injecte jamais le texte du modèle", () => {
    const injected = "Lyon'; DROP TABLE x; --";
    const q = buildDatasetQuery(ds, { select: ["magasin"], where: [{ column: "MAGASIN", op: "eq", value: injected }] });
    expect(q.columns).toEqual(["Magasin"]);
    expect(q.values[3]).toBe(injected);
    expect(q.text).not.toContain("DROP");
    expect(q.text).toContain(`(r.data->>'Magasin') = $4`);
  });

  it("une valeur non numérique sur une colonne number est refusée", () => {
    expect(() => buildDatasetQuery(ds, { where: [{ column: "CA HT", op: "gt", value: "abc" }] })).toThrow(/numérique attendue/);
  });

  it("aggregateAlias donne un identifiant SQL sûr", () => {
    expect(aggregateAlias({ fn: "sum", column: "CA HT" })).toBe("sum_ca_ht");
    expect(aggregateAlias({ fn: "avg", column: "Prix (€)" })).toBe("avg_prix");
    expect(aggregateAlias({ fn: "count" })).toBe("count");
  });
});
