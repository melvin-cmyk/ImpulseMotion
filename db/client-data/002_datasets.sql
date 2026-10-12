-- Entrepôt client_data — jeux de données déposés par l'équipe (fichiers CSV / XLSX /
-- Google Sheets d'un dossier Drive par client, chargés par n8n via /api/ingest/files).
-- Toutes les lignes portent client_key = ClientBot.clientKey. Idempotent.
--
-- Un chargement (load_id) est écrit par lots dans dataset_rows ; il ne devient
-- visible qu'à la fin, quand datasets.current_load_id bascule dessus. Les lignes
-- des chargements précédents (ou abandonnés) sont alors supprimées.

CREATE TABLE IF NOT EXISTS client_data.datasets (
  client_key       text        NOT NULL,
  dataset_key      text        NOT NULL,            -- slug du nom de fichier
  name             text        NOT NULL,            -- nom de fichier sans extension
  description      text,                            -- rédigée par un admin, lue par le bot
  columns          jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- [{name, type, sample}]
  row_count        int         NOT NULL DEFAULT 0,
  current_load_id  text,
  source           jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- {driveFileId, fileName, mimeType, modifiedTime, folderId}
  last_error       text,
  loaded_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_key, dataset_key)
);

CREATE TABLE IF NOT EXISTS client_data.dataset_rows (
  client_key   text   NOT NULL,
  dataset_key  text   NOT NULL,
  load_id      text   NOT NULL,
  row_no       int    NOT NULL,
  data         jsonb  NOT NULL,
  PRIMARY KEY (client_key, dataset_key, load_id, row_no)
);

-- Le rôle lecture seule du MCP (im_reader) doit voir les nouvelles tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'im_reader') THEN
    GRANT USAGE ON SCHEMA client_data TO im_reader;
    GRANT SELECT ON client_data.datasets, client_data.dataset_rows TO im_reader;
  END IF;
END $$;
