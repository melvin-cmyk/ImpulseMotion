// ImpulseMotion — Bots clients : fichiers de données (Drive). n8n workflow written with the
// n8n Workflow SDK (like pilot-google-write.workflow.js). Created in the n8n project
// « Google analytics API » because the Drive credential lives there.
//
// Every 15 minutes:
//   1. GET  {APP}/api/ingest/files  (header X-Files-Secret)  → the Drive folders of the bots
//      whose source « Fichiers de données (Drive) » is ticked, with the files already loaded
//      ({ driveFileId: modifiedTime }).
//   2. For each folder, lists its files in Drive (credential « Google Drive account », data@).
//   3. Keeps CSV / XLSX / XLS / Google Sheets that are new or modified since their last load.
//   4. One file at a time: downloads it (Sheets are exported as CSV), extracts the rows
//      (first row = headers), splits them in parts of 1 000 rows and POSTs each part to
//      {APP}/api/ingest/files with one loadId; the last part carries final: true, which makes
//      the new version visible and drops the previous one. The client is the folder's bot,
//      resolved by the application — the flow never names a client.
//   5. A file that cannot be read is reported to the same route as { error } so it shows on
//      the admin page (/admin/bots/<dashboard>).
//
// Not an MCP tool, not a webhook: nothing can call it from outside. Keep « Available in MCP » OFF.
//
// The SDK sandbox accepts literals only (no helper functions, no .join): the four download /
// extract pairs are spelled out. Before creating the flow, replace __FILES_SECRET__ with the
// value of BOT_FILES_SECRET on Vercel (it is written in the HTTP nodes; n8n editors can read
// it — move it to a Header Auth credential if that becomes a concern).

const every15 = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: { name: 'Toutes les 15 minutes', parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } } },
});

const getFolders = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Dossiers à surveiller (ImpulseMotion)',
    parameters: {
      method: 'GET',
      url: 'https://impulsemotion.vercel.app/api/ingest/files',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'X-Files-Secret', value: '__FILES_SECRET__' }] },
      options: { timeout: 30000 },
    },
  },
  output: [{ folders: [{ folderId: '1abc', clientKey: 'dt', files: {} }], maxRowsPerPart: 2000 }],
});

const oneItemPerFolder = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Un élément par dossier',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const out = [];\nfor (const item of $input.all()) {\n  for (const f of (item.json.folders || [])) {\n    if (f && typeof f.folderId === 'string') out.push({ json: { folderId: f.folderId, clientKey: f.clientKey, known: f.files || {} } });\n  }\n}\nreturn out;",
    },
  },
  output: [{ folderId: '1abc', clientKey: 'dt', known: {} }],
});

const listFiles = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Fichiers du dossier (Drive)',
    parameters: {
      method: 'GET',
      url: 'https://www.googleapis.com/drive/v3/files',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleDriveOAuth2Api',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'q', value: expr("{{ \"'\" + $json.folderId + \"' in parents and trashed = false\" }}") },
          { name: 'fields', value: 'files(id,name,mimeType,modifiedTime,size)' },
          { name: 'pageSize', value: '200' },
          { name: 'supportsAllDrives', value: 'true' },
          { name: 'includeItemsFromAllDrives', value: 'true' },
        ],
      },
      options: { timeout: 30000 },
    },
    credentials: { googleDriveOAuth2Api: { id: 'Jhztyo1jmFFAu5sY', name: 'Google Drive account' } },
    onError: 'continueRegularOutput',
  },
  output: [{ files: [{ id: '1file', name: 'ventes.csv', mimeType: 'text/csv', modifiedTime: '2026-10-12T10:00:00.000Z' }] }],
});

const pickChanged = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Fichiers nouveaux ou modifiés',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const folders = $('Un élément par dossier').all();\nconst SHEET = 'application/vnd.google-apps.spreadsheet';\nconst kinds = {\n  'text/csv': 'csv', 'text/plain': 'csv', 'application/csv': 'csv', 'text/comma-separated-values': 'csv',\n  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',\n  'application/vnd.ms-excel': 'xls',\n  [SHEET]: 'sheet',\n};\nconst byExt = (name) => (/\\.csv$/i.test(name) ? 'csv' : /\\.xlsx$/i.test(name) ? 'xlsx' : /\\.xls$/i.test(name) ? 'xls' : null);\nconst out = [];\n$input.all().forEach((item, i) => {\n  const folder = folders[i] ? folders[i].json : null;\n  if (!folder) return;\n  for (const f of (item.json.files || [])) {\n    if (!f || typeof f.id !== 'string') continue;\n    const kind = kinds[f.mimeType] || byExt(f.name || '');\n    if (!kind) continue;\n    const known = folder.known[f.id];\n    if (known && f.modifiedTime && known >= f.modifiedTime) continue;\n    out.push({ json: { folderId: folder.folderId, clientKey: folder.clientKey, kind, file: { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime } } });\n  }\n});\nreturn out;",
    },
  },
  output: [{ folderId: '1abc', clientKey: 'dt', kind: 'csv', file: { id: '1file', name: 'ventes.csv', mimeType: 'text/csv', modifiedTime: '2026-10-12T10:00:00.000Z' } }],
});

const eachFile = splitInBatches({ version: 3, config: { name: 'Un fichier à la fois', parameters: { batchSize: 1 } } });

const byKind = switchCase({
  version: 3.4,
  config: {
    name: 'Quel format ?',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          { outputKey: 'sheet', renameOutput: true, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ leftValue: expr('{{ $json.kind }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'sheet' }], combinator: 'and' } },
          { outputKey: 'csv', renameOutput: true, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ leftValue: expr('{{ $json.kind }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'csv' }], combinator: 'and' } },
          { outputKey: 'xlsx', renameOutput: true, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ leftValue: expr('{{ $json.kind }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'xlsx' }], combinator: 'and' } },
          { outputKey: 'xls', renameOutput: true, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ leftValue: expr('{{ $json.kind }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'xls' }], combinator: 'and' } },
        ],
      },
      options: { fallbackOutput: 'none' },
    },
  },
});

// Downloads (Sheets are exported as CSV). Error output → « Signaler un fichier illisible ».
const exportSheet = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Exporter la feuille en CSV',
    parameters: {
      method: 'GET',
      url: expr('https://www.googleapis.com/drive/v3/files/{{ $json.file.id }}/export?mimeType=text/csv'),
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleDriveOAuth2Api',
      options: { timeout: 120000, response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
    },
    credentials: { googleDriveOAuth2Api: { id: 'Jhztyo1jmFFAu5sY', name: 'Google Drive account' } },
    onError: 'continueErrorOutput',
  },
  output: [{}],
});
const downloadCsv = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Télécharger le CSV',
    parameters: {
      method: 'GET',
      url: expr('https://www.googleapis.com/drive/v3/files/{{ $json.file.id }}?alt=media&supportsAllDrives=true'),
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleDriveOAuth2Api',
      options: { timeout: 120000, response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
    },
    credentials: { googleDriveOAuth2Api: { id: 'Jhztyo1jmFFAu5sY', name: 'Google Drive account' } },
    onError: 'continueErrorOutput',
  },
  output: [{}],
});
const downloadXlsx = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Télécharger le XLSX',
    parameters: {
      method: 'GET',
      url: expr('https://www.googleapis.com/drive/v3/files/{{ $json.file.id }}?alt=media&supportsAllDrives=true'),
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleDriveOAuth2Api',
      options: { timeout: 120000, response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
    },
    credentials: { googleDriveOAuth2Api: { id: 'Jhztyo1jmFFAu5sY', name: 'Google Drive account' } },
    onError: 'continueErrorOutput',
  },
  output: [{}],
});
const downloadXls = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Télécharger le XLS',
    parameters: {
      method: 'GET',
      url: expr('https://www.googleapis.com/drive/v3/files/{{ $json.file.id }}?alt=media&supportsAllDrives=true'),
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleDriveOAuth2Api',
      options: { timeout: 120000, response: { response: { responseFormat: 'file', outputPropertyName: 'data' } } },
    },
    credentials: { googleDriveOAuth2Api: { id: 'Jhztyo1jmFFAu5sY', name: 'Google Drive account' } },
    onError: 'continueErrorOutput',
  },
  output: [{}],
});

// Extraction (first row = headers). alwaysOutputData: an empty file still reaches the next
// node, which reports it and lets the loop go on.
const extractSheet = node({
  type: 'n8n-nodes-base.extractFromFile',
  version: 1.1,
  config: {
    name: 'Lire la feuille (CSV)',
    parameters: { operation: 'csv', binaryPropertyName: 'data', options: { headerRow: true, includeEmptyCells: true, enableBOM: true, relaxQuotes: true } },
    alwaysOutputData: true,
    onError: 'continueErrorOutput',
  },
  output: [{ Magasin: 'Lyon', CA: '1 000,00' }],
});
const extractCsv = node({
  type: 'n8n-nodes-base.extractFromFile',
  version: 1.1,
  config: {
    name: 'Lire le CSV',
    parameters: { operation: 'csv', binaryPropertyName: 'data', options: { headerRow: true, includeEmptyCells: true, enableBOM: true, relaxQuotes: true } },
    alwaysOutputData: true,
    onError: 'continueErrorOutput',
  },
  output: [{ Magasin: 'Lyon', CA: '1 000,00' }],
});
const extractXlsx = node({
  type: 'n8n-nodes-base.extractFromFile',
  version: 1.1,
  config: {
    name: 'Lire le XLSX',
    parameters: { operation: 'xlsx', binaryPropertyName: 'data', options: { headerRow: true, includeEmptyCells: true } },
    alwaysOutputData: true,
    onError: 'continueErrorOutput',
  },
  output: [{ Magasin: 'Lyon', CA: '1 000,00' }],
});
const extractXls = node({
  type: 'n8n-nodes-base.extractFromFile',
  version: 1.1,
  config: {
    name: 'Lire le XLS',
    parameters: { operation: 'xls', binaryPropertyName: 'data', options: { headerRow: true, includeEmptyCells: true } },
    alwaysOutputData: true,
    onError: 'continueErrorOutput',
  },
  output: [{ Magasin: 'Lyon', CA: '1 000,00' }],
});

const splitParts = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Découper en lots',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "// The file being processed is the current item of the loop.\nconst ctx = $('Un fichier à la fois').first().json;\nconst rows = $input.all().map((i) => i.json).filter((r) => r && typeof r === 'object');\n// Columns = union of the keys, in order of first appearance; drop fully empty columns.\nconst columns = [];\nfor (const r of rows) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);\nconst nonEmpty = columns.filter((c) => rows.some((r) => r[c] !== null && r[c] !== undefined && String(r[c]).trim() !== ''));\nconst kept = nonEmpty.length ? nonEmpty : columns;\n// Drop rows with no value at all (trailing blank lines).\nconst data = rows.filter((r) => kept.some((c) => r[c] !== null && r[c] !== undefined && String(r[c]).trim() !== ''));\nconst base = { folderId: ctx.folderId, file: ctx.file };\nif (!kept.length || !data.length) return [{ json: { ...base, error: 'Fichier vide ou sans en-têtes lisibles.' } }];\nif (data.length > 200000) return [{ json: { ...base, error: 'Fichier trop grand : ' + data.length + ' lignes (200 000 max).' } }];\nconst loadId = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);\nconst PART = 1000;\nconst parts = [];\nfor (let i = 0; i < data.length; i += PART) {\n  parts.push({ json: { ...base, loadId, rowOffset: i, columns: kept, rows: data.slice(i, i + PART), final: i + PART >= data.length } });\n}\nreturn parts;",
    },
  },
  output: [{ folderId: '1abc', file: { id: '1file', name: 'ventes.csv' }, loadId: 'l1', rowOffset: 0, columns: ['Magasin', 'CA'], rows: [{ Magasin: 'Lyon', CA: '1 000,00' }], final: true }],
});

const sendPart = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Envoyer le lot à ImpulseMotion',
    parameters: {
      method: 'POST',
      url: 'https://impulsemotion.vercel.app/api/ingest/files',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'X-Files-Secret', value: '__FILES_SECRET__' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json) }}'),
      options: { timeout: 60000, batching: { batch: { batchSize: 1, batchInterval: 200 } } },
    },
    onError: 'continueRegularOutput',
  },
  output: [{ ok: true, dataset: 'ventes', rowsWritten: 1, finalized: true }],
});

const readError = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Signaler un fichier illisible',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const ctx = $('Un fichier à la fois').first().json;\nconst first = $input.first();\nconst msg = (first && first.json && (first.json.error && (first.json.error.message || first.json.error)) || first.error && first.error.message || 'Lecture impossible').toString();\nreturn [{ json: { folderId: ctx.folderId, file: ctx.file, error: ('Fichier illisible : ' + msg).slice(0, 500) } }];",
    },
  },
  output: [{ folderId: '1abc', file: { id: '1file', name: 'ventes.csv' }, error: 'Fichier illisible : …' }],
});

const sendError = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: "Consigner l'erreur dans ImpulseMotion",
    parameters: {
      method: 'POST',
      url: 'https://impulsemotion.vercel.app/api/ingest/files',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'X-Files-Secret', value: '__FILES_SECRET__' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json) }}'),
      options: { timeout: 30000 },
    },
    onError: 'continueRegularOutput',
  },
  output: [{ ok: true, recorded: 'error' }],
});

const done = node({
  type: 'n8n-nodes-base.noOp',
  version: 1,
  config: { name: 'Terminé' },
});

export default workflow('impulsemotion-bot-files', 'ImpulseMotion — Bots clients : fichiers de données (Drive)')
  .add(every15)
  .to(getFolders)
  .to(oneItemPerFolder)
  .to(listFiles)
  .to(pickChanged)
  .to(eachFile
    .onDone(done)
    .onEachBatch(byKind
      .onCase(0, exportSheet.onError(readError.to(sendError.to(nextBatch(eachFile)))).to(extractSheet.onError(readError).to(splitParts.to(sendPart.to(nextBatch(eachFile))))))
      .onCase(1, downloadCsv.onError(readError).to(extractCsv.onError(readError).to(splitParts)))
      .onCase(2, downloadXlsx.onError(readError).to(extractXlsx.onError(readError).to(splitParts)))
      .onCase(3, downloadXls.onError(readError).to(extractXls.onError(readError).to(splitParts)))));
