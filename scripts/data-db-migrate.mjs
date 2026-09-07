#!/usr/bin/env node
/**
 * Applique les migrations SQL de l'entrepôt client_data (db/client-data/*.sql).
 *
 * Idempotent : chaque fichier est joué une seule fois, dans une transaction, et
 * consigné dans client_data.schema_migrations. Les fichiers eux-mêmes doivent
 * rester rejouables (IF NOT EXISTS) pour tolérer une reprise après échec.
 *
 * Usage : DATA_DATABASE_URL=postgres://... node scripts/data-db-migrate.mjs
 * (fallback : DB_DATABASE_URL). Utiliser l'URL OWNER, pas l'URL lecture seule.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, "..", "db", "client-data");

const url = process.env.DATA_DATABASE_URL || process.env.DB_DATABASE_URL;
if (!url) {
  console.error("[data-db-migrate] DATA_DATABASE_URL (ou DB_DATABASE_URL) manquante");
  process.exit(1);
}

function sslFor(connectionString) {
  const u = new URL(connectionString);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  u.searchParams.delete("sslmode");
  u.searchParams.delete("channel_binding");
  return { connectionString: u.toString(), ssl: local ? undefined : { rejectUnauthorized: true } };
}

const client = new pg.Client(sslFor(url));
await client.connect();
try {
  await client.query("CREATE SCHEMA IF NOT EXISTS client_data");
  await client.query(`CREATE TABLE IF NOT EXISTS client_data.schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await client.query("SELECT name FROM client_data.schema_migrations");
  const applied = new Set(rows.map((r) => r.name));

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) { console.log(`[data-db-migrate] déjà appliquée : ${file}`); continue; }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO client_data.schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`[data-db-migrate] appliquée : ${file}`);
      count++;
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`${file} : ${err.message}`);
    }
  }
  console.log(`[data-db-migrate] terminé — ${count} nouvelle(s) migration(s), ${files.length} au total`);
} finally {
  await client.end();
}
