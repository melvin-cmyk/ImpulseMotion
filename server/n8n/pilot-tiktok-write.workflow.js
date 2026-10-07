// ImpulseMotion — Pilotage : écritures TikTok Ads. n8n workflow, written with the
// n8n Workflow SDK (twin of pilot-google-write.workflow.js). Called by lib/pilot/tiktok.ts
// (writeTikTokField), only after the consultant confirmed the preview in /pilotage.
//
// Not an MCP tool on purpose: no AI can reach it. Only ImpulseMotion, with its own secret.
//
// Receives  POST …/webhook/impulsemotion-tiktok-write
//           header X-Pilot-Secret, body { version: 1, advertiserId, endpoint, body }
//   endpoint  "campaign/status/update" | "adgroup/status/update" | "ad/status/update" | "campaign/update" | "adgroup/update"
//   body      advertiser_id must equal advertiserId; status updates: <level>_ids (one id) + operation_status ENABLE|DISABLE|DELETE;
//             updates: <level>_id + one of campaign_name / adgroup_name / budget / bid_price+conversion_bid_price / schedule_end_time
//   200 { ok: true, result, tiktokCode: 0 }        TikTok applied it (code 0)
//   200 { ok: false, error, tiktokCode }           TikTok refused it (its message)
//   400 { ok: false, error }                       request refused before reaching TikTok
//   401 { ok: false, error: "unauthorized" }       wrong or missing X-Pilot-Secret
//
// Secret: only its SHA-256 (hex) lives in the flow; the secret itself is PILOT_TIKTOK_WEBHOOK_SECRET on Vercel.
// Credential: « Tiktok API » (httpHeaderAuth 7fbaH29EfePQdGuS, header Access-Token), the one of the read-only MCP flow.
// Keep « Available in MCP » OFF for this flow.
//
// Environment of the application (Vercel):
//   PILOT_TIKTOK_WEBHOOK_SECRET   the secret above
//   PILOT_TIKTOK_WEBHOOK_URL      the production URL of this webhook
//   PILOT_TIKTOK_WRITES=1         opens the sending (PILOT_WRITES=1 is also required) — closed until the first real test

const incoming = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Demande ImpulseMotion',
    parameters: { httpMethod: 'POST', path: 'impulsemotion-tiktok-write', responseMode: 'responseNode' },
  },
  output: [{ headers: { 'x-pilot-secret': 'secret' }, body: { version: 1, advertiserId: '7012345678901234567', endpoint: 'campaign/status/update', body: { advertiser_id: '7012345678901234567', campaign_ids: ['1'], operation_status: 'DISABLE' } } }],
});

// Only the SHA-256 of the secret is written in the flow: reading the flow (MCP, export) does not give the key.
const hashSecret = node({
  type: 'n8n-nodes-base.crypto',
  version: 1,
  config: {
    name: 'Empreinte du secret',
    parameters: { action: 'hash', type: 'SHA256', value: expr('{{ $json.headers["x-pilot-secret"] || "" }}'), dataPropertyName: 'secretHash', encoding: 'hex' },
  },
  output: [{ secretHash: 'abc', headers: {}, body: {} }],
});

const secretOk = ifElse({
  version: 2.3,
  config: {
    name: 'Secret valide ?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.secretHash }}'), rightValue: 'd5b7ebb6f906a73dabd789eb9570fe6078b2a31437b8b397f675de4901ceccf9', operator: { type: 'string', operation: 'equals' } }],
        combinator: 'and',
      },
    },
  },
});

const refuse = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: { name: 'Refus 401', parameters: { respondWith: 'json', responseBody: '{"ok": false, "error": "unauthorized"}', options: { responseCode: 401 } } },
  output: [{}],
});

const check = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Contrôler la demande',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const body = $input.first().json.body || {};\nconst fail = (error) => [{ json: { valid: false, error } }];\nif (body.version !== 1) return fail('unknown version');\nconst advertiserId = String(body.advertiserId || '');\nif (!/^\\d{5,25}$/.test(advertiserId)) return fail('invalid advertiserId');\nconst endpoints = ['campaign/status/update', 'adgroup/status/update', 'ad/status/update', 'campaign/update', 'adgroup/update'];\nconst endpoint = body.endpoint;\nif (!endpoints.includes(endpoint)) return fail('endpoint not allowed');\nconst b = body.body || {};\nif (String(b.advertiser_id || '') !== advertiserId) return fail('advertiser mismatch');\nconst level = endpoint.split('/')[0];\nconst isId = (v) => typeof v === 'string' && /^\\d{5,25}$/.test(v);\nlet payload;\nif (endpoint.endsWith('status/update')) {\n  const ids = b[`${level}_ids`];\n  if (!Array.isArray(ids) || ids.length !== 1 || !isId(ids[0])) return fail('one id expected');\n  if (!['ENABLE', 'DISABLE', 'DELETE'].includes(b.operation_status)) return fail('invalid operation_status');\n  payload = { advertiser_id: advertiserId, [`${level}_ids`]: [ids[0]], operation_status: b.operation_status };\n} else {\n  const id = b[`${level}_id`];\n  if (!isId(id)) return fail('invalid id');\n  payload = { advertiser_id: advertiserId, [`${level}_id`]: id };\n  const keys = Object.keys(b).filter((k) => k !== 'advertiser_id' && k !== `${level}_id`);\n  const allowed = level === 'campaign' ? ['campaign_name', 'budget'] : ['adgroup_name', 'budget', 'bid_price', 'conversion_bid_price', 'schedule_end_time'];\n  if (!keys.length || !keys.every((k) => allowed.includes(k))) return fail('field not allowed');\n  const isMoney = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e9;\n  for (const k of keys) {\n    const v = b[k];\n    if (/_name$/.test(k)) { if (typeof v !== 'string' || !v.trim() || v.length > 512) return fail('invalid name'); payload[k] = v; }\n    else if (k === 'schedule_end_time') { if (typeof v !== 'string' || !/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/.test(v)) return fail('invalid schedule_end_time'); payload[k] = v; }\n    else { if (!isMoney(v)) return fail(`invalid ${k}`); payload[k] = v; }\n  }\n  // A name alone, a budget alone, a bid alone, a date alone: one setting per call, as Pilotage sends them.\n  const groups = new Set(keys.map((k) => (k === 'bid_price' || k === 'conversion_bid_price' ? 'bid' : k)));\n  if (groups.size !== 1) return fail('one setting per call');\n}\nreturn [{ json: { valid: true, advertiserId, endpoint, payload } }];",
    },
  },
  output: [{ valid: true, advertiserId: '7012345678901234567', endpoint: 'campaign/status/update', payload: {}, error: '' }],
});

const valid = ifElse({
  version: 2.3,
  config: {
    name: 'Demande valide ?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.valid }}'), rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
    },
  },
});

const invalid = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Demande invalide 400',
    parameters: { respondWith: 'json', responseBody: expr('{{ JSON.stringify({ ok: false, error: $json.error || "invalid request" }) }}'), options: { responseCode: 400 } },
  },
  output: [{}],
});

const mutate = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Écrire dans TikTok Ads',
    parameters: {
      method: 'POST',
      url: expr('https://business-api.tiktok.com/open_api/v1.3/{{ $json.endpoint }}/'),
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'httpHeaderAuth',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.payload) }}'),
      options: { response: { response: { neverError: true, fullResponse: true } } },
    },
    credentials: { httpHeaderAuth: { id: '7fbaH29EfePQdGuS', name: 'Tiktok API' } },
    onError: 'continueRegularOutput',
  },
  output: [{ statusCode: 200, body: { code: 0, message: 'OK', data: {} } }],
});

const answer = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Réponse',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify($json.statusCode >= 200 && $json.statusCode < 300 && $json.body && $json.body.code === 0 ? { ok: true, result: $json.body.data || null, tiktokCode: 0 } : { ok: false, tiktokCode: $json.body && typeof $json.body.code === "number" ? $json.body.code : null, httpStatus: typeof $json.statusCode === "number" ? $json.statusCode : null, error: ($json.body && $json.body.message) || $json.error?.message || ("tiktok_" + ($json.statusCode || "error")) }) }}'),
      options: { responseCode: 200 },
    },
  },
  output: [{}],
});

export default workflow('impulsemotion-tiktok-write', 'ImpulseMotion — Pilotage : écritures TikTok Ads')
  .add(incoming)
  .to(hashSecret.to(secretOk
    .onTrue(check.to(valid
      .onTrue(mutate.to(answer))
      .onFalse(invalid)))
    .onFalse(refuse)));
