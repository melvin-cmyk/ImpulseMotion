// ImpulseMotion — Magento LPEV : S3 → entrepôt. n8n workflow written with the n8n Workflow
// SDK (like bot-files.workflow.js). Created in the n8n project « Google analytics API »,
// where the AWS credential « AWS (IAM) account » (EfMZXcNv7eklcNr2) lives.
//
// Why: the live Magento API (MCP « Magento LPEV ») takes 10–30 s per call and is rate
// limited; a question spanning weeks timed out. The export flow « Magento LPEV — Commandes +
// code prescripteur » already writes, every day at 05:50, one CSV per month
// (lpev_commandes_YYYY-MM.csv: previous month + current month, one row per order line,
// 32 columns) in the S3 bucket lpev-funnel-import-csv for Funnel / Data Studio. This flow
// loads those same files into the ImpulseMotion warehouse (client_data.orders /
// order_items, client « lpev »), so consultants and Data Studio see the same figures.
//
// Every day at 06:30 (after the 05:50 export):
//   1. Lists the bucket; keeps lpev_commandes_YYYY-MM.csv for the current and the previous
//      month (manual trigger « Backfill » : every monthly file present).
//   2. One file at a time: downloads it, reads the CSV (first row = headers), splits the rows
//      into parts of at most 2 000 rows WITHOUT cutting an order (the ingest route replaces
//      the lines of an order by those of the part received), POSTs each part to
//      {APP}/api/ingest/orders with the bot's bearer token. The client is the token's bot
//      (« lpev »), resolved by the application — the flow never names a client.
//   3. A summary per file is kept in the execution (parts sent, rows, errors).
//
// Not an MCP tool, not a webhook: nothing can call it from outside. Keep « Available in MCP » OFF.
//
// Before creating the flow, replace __INGEST_TOKEN__ with the token generated for the LPEV
// bot (/admin/bots → LPEV → « Générer un token d'ingestion »). It is written in the HTTP node;
// n8n editors can read it — move it to a Header Auth credential if that becomes a concern.

const daily = trigger({
  type: 'n8n-nodes-base.scheduleTrigger',
  version: 1.4,
  config: { name: 'Chaque jour 06h30', parameters: { rule: { interval: [{ field: 'days', triggerAtHour: 6, triggerAtMinute: 30 }] } } },
});

const backfill = trigger({
  type: 'n8n-nodes-base.manualTrigger',
  version: 1,
  config: { name: 'Backfill (à la main : tout l’historique)' },
});

const listFiles = node({
  type: 'n8n-nodes-base.awsS3',
  version: 2,
  config: {
    name: 'Lister les fichiers (S3)',
    parameters: { resource: 'file', operation: 'getAll', bucketName: 'lpev-funnel-import-csv', returnAll: true, options: {} },
    credentials: { aws: { id: 'EfMZXcNv7eklcNr2', name: 'AWS (IAM) account' } },
    executeOnce: true,
  },
  output: [{ Key: 'lpev_commandes_2026-10.csv', LastModified: '2026-10-15T03:51:00.000Z', Size: '1234' }],
});

const pickFiles = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Fichiers à charger',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "// Monthly exports only. Daily run: current + previous month (the export refreshes both);\n// manual « Backfill »: every monthly file present in the bucket.\nconst isBackfill = $('Backfill (à la main : tout l’historique)').isExecuted;\nconst now = $now.setZone('Europe/Paris');\nconst cur = now.toFormat('yyyy-MM');\nconst prev = now.minus({ months: 1 }).toFormat('yyyy-MM');\nconst out = [];\nfor (const item of $input.all()) {\n  const key = item.json.Key;\n  const m = typeof key === 'string' ? key.match(/^lpev_commandes_(\\d{4}-\\d{2})\\.csv$/) : null;\n  if (!m) continue;\n  if (!isBackfill && m[1] !== cur && m[1] !== prev) continue;\n  out.push({ json: { key, month: m[1], size: Number(item.json.Size || 0), lastModified: item.json.LastModified || null, backfill: isBackfill } });\n}\nout.sort((a, b) => (a.json.month < b.json.month ? -1 : a.json.month > b.json.month ? 1 : 0));\nreturn out;",
    },
  },
  output: [{ key: 'lpev_commandes_2026-10.csv', month: '2026-10', size: 1234, lastModified: '2026-10-15T03:51:00.000Z', backfill: false }],
});

const eachFile = splitInBatches({ version: 3, config: { name: 'Un fichier à la fois', parameters: { batchSize: 1 } } });

const done = node({ type: 'n8n-nodes-base.noOp', version: 1, config: { name: 'Terminé' } });

const download = node({
  type: 'n8n-nodes-base.awsS3',
  version: 2,
  config: {
    name: 'Télécharger le fichier (S3)',
    parameters: { resource: 'file', operation: 'download', bucketName: 'lpev-funnel-import-csv', fileKey: expr('{{ $json.key }}'), binaryPropertyName: 'data' },
    credentials: { aws: { id: 'EfMZXcNv7eklcNr2', name: 'AWS (IAM) account' } },
  },
});

const readCsv = node({
  type: 'n8n-nodes-base.extractFromFile',
  version: 1.1,
  config: {
    name: 'Lire le CSV',
    parameters: { operation: 'csv', binaryPropertyName: 'data', options: { headerRow: true, includeEmptyCells: true, enableBOM: true, relaxQuotes: true } },
    alwaysOutputData: true,
  },
  output: [{ order_id: '000419665', entity_id: '419665', created_at: '2026-10-06 08:12:33', status: 'complete', sku: 'ABC', is_order_head: '1', grand_total: '59.9' }],
});

const splitParts = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Découper par commandes',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "// Parts of at most MAX rows, never cutting an order: the ingest route replaces the lines\n// of an order by those of the part it receives.\nconst file = $('Un fichier à la fois').first().json;\nconst MAX = 2000;\nconst rows = $input.all().map((i) => i.json).filter((r) => r && typeof r === 'object' && r.order_id !== undefined && String(r.order_id).trim() !== '');\nif (!rows.length) return [{ json: { file: file.key, month: file.month, part: 0, parts: 0, rows: [], empty: true } }];\n// Group by order_id, keeping the file order.\nconst groups = new Map();\nfor (const r of rows) {\n  const id = String(r.order_id).trim();\n  if (!groups.has(id)) groups.set(id, []);\n  groups.get(id).push(r);\n}\nconst parts = [];\nlet current = [];\nfor (const lines of groups.values()) {\n  if (current.length && current.length + lines.length > MAX) { parts.push(current); current = []; }\n  for (const l of lines) current.push(l);\n}\nif (current.length) parts.push(current);\nreturn parts.map((p, i) => ({ json: { file: file.key, month: file.month, part: i + 1, parts: parts.length, orders: new Set(p.map((r) => String(r.order_id).trim())).size, rows: p } }));",
    },
  },
  output: [{ file: 'lpev_commandes_2026-10.csv', month: '2026-10', part: 1, parts: 3, orders: 950, rows: [{ order_id: '000419665' }] }],
});

const sendPart = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.5,
  config: {
    name: 'Envoyer le lot à ImpulseMotion',
    parameters: {
      method: 'POST',
      url: 'https://impulsemotion.vercel.app/api/ingest/orders',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'Authorization', value: 'Bearer __INGEST_TOKEN__' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ rows: $json.rows || [] }) }}'),
      options: { timeout: 90000, batching: { batch: { batchSize: 1, batchInterval: 300 } } },
    },
    onError: 'continueRegularOutput',
  },
  output: [{ ok: true, orders: 950, rows: 1990, items: 1990 }],
});

const fileSummary = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Bilan du fichier',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "// One line per file: what was sent and what the application answered.\nconst file = $('Un fichier à la fois').first().json;\nconst sent = $('Découper par commandes').all().map((i) => i.json);\nconst answers = $input.all().map((i) => i.json);\nconst okParts = answers.filter((a) => a && a.ok === true);\nconst errors = answers.filter((a) => !a || a.ok !== true).map((a) => (a && (a.error || (a.message))) || 'réponse inattendue');\nreturn [{ json: {\n  file: file.key, month: file.month,\n  parts: sent.filter((p) => !p.empty).length,\n  rows_sent: sent.reduce((n, p) => n + ((p.rows && p.rows.length) || 0), 0),\n  orders_sent: sent.reduce((n, p) => n + (p.orders || 0), 0),\n  parts_ok: okParts.length,\n  orders_upserted: okParts.reduce((n, a) => n + (Number(a.orders) || 0), 0),\n  errors: errors.slice(0, 5),\n} }];",
    },
  },
  output: [{ file: 'lpev_commandes_2026-10.csv', month: '2026-10', parts: 3, rows_sent: 5900, orders_sent: 2800, parts_ok: 3, orders_upserted: 2800, errors: [] }],
});

export default workflow('impulsemotion-magento-s3-ingest', 'ImpulseMotion — Magento LPEV : S3 → entrepôt')
  .add(daily)
  .to(listFiles)
  .add(backfill)
  .to(listFiles)
  .add(listFiles)
  .to(pickFiles)
  .to(eachFile
    .onDone(done)
    .onEachBatch(download.to(readCsv.to(splitParts.to(sendPart.to(fileSummary.to(nextBatch(eachFile))))))));
