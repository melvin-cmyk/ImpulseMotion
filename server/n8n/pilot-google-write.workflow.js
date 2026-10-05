// ImpulseMotion — Pilotage : écritures Google Ads. n8n workflow TO PUBLISH, written with the
// n8n Workflow SDK (like client-alerts-dm.workflow.js). Called by lib/pilot/google.ts
// (writeGoogleField), only after the consultant confirmed the preview in /pilotage.
//
// Not an MCP tool on purpose: no AI can reach it. Only ImpulseMotion, with its own secret.
//
// Receives  POST …/webhook/impulsemotion-google-write
//           header X-Pilot-Secret, body { version: 1, customerId, resource, operation }
//   resource   "campaigns" | "adGroups" | "campaignBudgets"
//   operation  { update: { resourceName, …fields }, updateMask } | { remove: resourceName }
//              resourceName must start with customers/<customerId>/<resource>/
//              updateMask limited to: status, name, cpc_bid_micros, amount_micros, total_amount_micros
//   200 { ok: true, result }          Google Ads applied the mutate
//   200 { ok: false, error }          Google Ads refused it (its message)
//   400 { ok: false, error }          request refused before reaching Google
//   401 { ok: false, error: "unauthorized" }   wrong or missing X-Pilot-Secret
//
// Before publishing, replace:
//   __SECRET_SHA256__     the SHA-256 (hex) of the secret set on Vercel as PILOT_GOOGLE_WEBHOOK_SECRET —
//                         only the hash lives in the flow
//   __DEVELOPER_TOKEN__   the Google Ads developer token (as in the flow « MCP Google Ads - Impulse »)
// and keep « Available in MCP » OFF for this flow.
//   200 replies carry googleStatus (Google's HTTP status, null when Google was not reached):
//   the app reads a 4xx as refused, anything else as an unknown outcome.
// Credential: « Google Ads account » (googleAdsOAuth2Api, id 2jFRGCsXDsMa6uBy), manager 7311173397.
//
// Environment of the application (Vercel):
//   PILOT_GOOGLE_WEBHOOK_SECRET   the secret above
//   PILOT_GOOGLE_WEBHOOK_URL      only if N8N_ALERT_WEBHOOK_URL does not end with /impulsemotion-alerts
//   PILOT_GOOGLE_WRITES=1         opens the sending (PILOT_WRITES=1 is also required)

const incoming = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Demande ImpulseMotion',
    parameters: { httpMethod: 'POST', path: 'impulsemotion-google-write', responseMode: 'responseNode' },
  },
  output: [{ headers: { 'x-pilot-secret': 'secret' }, body: { version: 1, customerId: '1234567890', resource: 'campaigns', operation: { update: { resourceName: 'customers/1234567890/campaigns/1', status: 'PAUSED' }, updateMask: 'status' } } }],
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
        conditions: [{ leftValue: expr('{{ $json.secretHash }}'), rightValue: '__SECRET_SHA256__', operator: { type: 'string', operation: 'equals' } }],
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
      jsCode: [
        "const body = $input.first().json.body || {};",
        "const fail = (error) => [{ json: { valid: false, error } }];",
        "if (body.version !== 1) return fail('unknown version');",
        "const customerId = String(body.customerId || '');",
        "if (!/^\\d{6,12}$/.test(customerId)) return fail('invalid customerId');",
        "const resource = body.resource;",
        "if (!['campaigns', 'adGroups', 'campaignBudgets'].includes(resource)) return fail('resource not allowed');",
        "const prefix = `customers/${customerId}/${resource}/`;",
        "const op = body.operation || {};",
        "const masks = { campaigns: ['status', 'name'], adGroups: ['status', 'name', 'cpc_bid_micros'], campaignBudgets: ['amount_micros', 'total_amount_micros'] };",
        "let operation;",
        "if (typeof op.remove === 'string') {",
        "  if (resource === 'campaignBudgets') return fail('remove not allowed on budgets');",
        "  if (!op.remove.startsWith(prefix) || !/^\\d+$/.test(op.remove.slice(prefix.length))) return fail('invalid resourceName');",
        "  operation = { remove: op.remove };",
        "} else if (op.update && typeof op.update === 'object') {",
        "  const name = String(op.update.resourceName || '');",
        "  if (!name.startsWith(prefix) || !/^\\d+$/.test(name.slice(prefix.length))) return fail('invalid resourceName');",
        "  if (!masks[resource].includes(op.updateMask)) return fail('updateMask not allowed');",
        "  const camel = op.updateMask.replace(/_([a-z])/g, (_, c) => c.toUpperCase());",
        "  const keys = Object.keys(op.update).filter((k) => k !== 'resourceName');",
        "  if (keys.length !== 1 || keys[0] !== camel) return fail('fields do not match updateMask');",
        "  operation = { update: { resourceName: name, [camel]: op.update[camel] }, updateMask: op.updateMask };",
        "} else return fail('unknown operation');",
        "return [{ json: { valid: true, customerId, resource, payload: { operations: [operation], partialFailure: false } } }];",
      ].join('\n'),
    },
  },
  output: [{ valid: true, customerId: '1234567890', resource: 'campaigns', payload: { operations: [] }, error: '' }],
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
    name: 'Écrire dans Google Ads',
    parameters: {
      method: 'POST',
      url: expr('https://googleads.googleapis.com/v23/customers/{{ $json.customerId }}/{{ $json.resource }}:mutate'),
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'googleAdsOAuth2Api',
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'developer-token', value: '__DEVELOPER_TOKEN__' }, { name: 'login-customer-id', value: '7311173397' }] },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify($json.payload) }}'),
      options: { response: { response: { neverError: true, fullResponse: true } } },
    },
    credentials: { googleAdsOAuth2Api: { id: '2jFRGCsXDsMa6uBy', name: 'Google Ads account' } },
    onError: 'continueRegularOutput',
  },
  output: [{ statusCode: 200, body: { results: [{ resourceName: 'customers/1234567890/campaigns/1' }] } }],
});

const answer = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Réponse',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify($json.statusCode >= 200 && $json.statusCode < 300 && Array.isArray($json.body?.results) ? { ok: true, result: $json.body.results, googleStatus: $json.statusCode } : { ok: false, googleStatus: typeof $json.statusCode === "number" ? $json.statusCode : null, error: ($json.body?.error?.details?.[0]?.errors?.[0]?.message) || $json.body?.error?.message || $json.error?.message || ("google_ads_" + ($json.statusCode || "error")) }) }}'),
      options: { responseCode: 200 },
    },
  },
  output: [{}],
});

export default workflow('impulsemotion-google-write', 'ImpulseMotion — Pilotage : écritures Google Ads')
  .add(incoming)
  .to(hashSecret.to(secretOk
    .onTrue(check.to(valid
      .onTrue(mutate.to(answer))
      .onFalse(invalid)))
    .onFalse(refuse)));
