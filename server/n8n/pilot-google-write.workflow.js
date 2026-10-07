// ImpulseMotion — Pilotage : écritures Google Ads. n8n workflow TO PUBLISH, written with the
// n8n Workflow SDK (like client-alerts-dm.workflow.js). Called by lib/pilot/google.ts
// (writeGoogleField), only after the consultant confirmed the preview in /pilotage.
//
// Not an MCP tool on purpose: no AI can reach it. Only ImpulseMotion, with its own secret.
//
// Receives  POST …/webhook/impulsemotion-google-write
//           header X-Pilot-Secret, body { version: 1, customerId, resource, operation }
//   resource   "campaigns" | "adGroups" | "campaignBudgets" | "adGroupCriteria" | "campaignCriteria" | "adGroupAds"
//   operation  { update: { resourceName, …fields }, updateMask } | { remove: resourceName }
//              | { create: { adGroup, status, keyword: { text, matchType } } }            (adGroupCriteria)
//              | { create: { campaign, negative: true, keyword: { text, matchType } } }   (campaignCriteria)
//              | { create: { adGroup, status, ad: { responsiveSearchAd: { headlines, descriptions, path1?, path2? }, finalUrls } } }  (adGroupAds)
//              adGroupAds also take update status / remove on « adGroupId~adId »
//              resourceName must start with customers/<customerId>/<resource>/
//              updateMask limited to: status, name, start_date_time, end_date_time (« yyyy-MM-dd HH:mm:ss »), cpc_bid_micros, amount_micros,
//              total_amount_micros, and the bidding targets (maximize_conversions.target_cpa_micros,
//              target_cpa.target_cpa_micros, maximize_conversion_value.target_roas, target_roas.target_roas,
//              ad group target_cpa_micros / target_roas) — a dotted mask takes a one-key nested object
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
      jsCode: "const body = $input.first().json.body || {};\nconst fail = (error) => [{ json: { valid: false, error } }];\nif (body.version !== 1) return fail('unknown version');\nconst customerId = String(body.customerId || '');\nif (!/^\\d{6,12}$/.test(customerId)) return fail('invalid customerId');\nconst resource = body.resource;\nif (!['campaigns', 'adGroups', 'campaignBudgets', 'adGroupCriteria', 'campaignCriteria', 'adGroupAds'].includes(resource)) return fail('resource not allowed');\nconst prefix = `customers/${customerId}/${resource}/`;\nconst op = body.operation || {};\nconst masks = { adGroupCriteria: ['status', 'cpc_bid_micros'], campaignCriteria: [], adGroupAds: ['status'], campaigns: ['status', 'name', 'start_date_time', 'end_date_time', 'maximize_conversions.target_cpa_micros', 'target_cpa.target_cpa_micros', 'maximize_conversion_value.target_roas', 'target_roas.target_roas'], adGroups: ['status', 'name', 'cpc_bid_micros', 'target_cpa_micros', 'target_roas'], campaignBudgets: ['amount_micros', 'total_amount_micros'] };\nlet operation;\nconst idRe = /^\\d+(~\\d+)?$/;\nconst matchTypes = ['EXACT', 'PHRASE', 'BROAD'];\nconst keywordOk = (k) => k && typeof k === 'object' && typeof k.text === 'string' && k.text.length >= 2 && k.text.length <= 80 && matchTypes.includes(k.matchType) && Object.keys(k).length === 2;\nif (typeof op.remove === 'string') {\n  if (resource === 'campaignBudgets') return fail('remove not allowed on budgets');\n  if (!op.remove.startsWith(prefix) || !idRe.test(op.remove.slice(prefix.length))) return fail('invalid resourceName');\n  operation = { remove: op.remove };\n} else if (op.create && typeof op.create === 'object') {\n  const c = op.create;\n  if (resource === 'adGroupCriteria') {\n    if (typeof c.adGroup !== 'string' || !c.adGroup.startsWith(`customers/${customerId}/adGroups/`) || !/^\\d+$/.test(c.adGroup.split('/').pop())) return fail('invalid adGroup');\n    if (!keywordOk(c.keyword) || !['ENABLED', 'PAUSED'].includes(c.status) || Object.keys(c).length !== 3) return fail('invalid keyword');\n    operation = { create: { adGroup: c.adGroup, status: c.status, keyword: { text: c.keyword.text, matchType: c.keyword.matchType } } };\n  } else if (resource === 'campaignCriteria') {\n    if (typeof c.campaign !== 'string' || !c.campaign.startsWith(`customers/${customerId}/campaigns/`) || !/^\\d+$/.test(c.campaign.split('/').pop())) return fail('invalid campaign');\n    if (!keywordOk(c.keyword) || c.negative !== true || Object.keys(c).length !== 3) return fail('invalid negative keyword');\n    operation = { create: { campaign: c.campaign, negative: true, keyword: { text: c.keyword.text, matchType: c.keyword.matchType } } };\n  } else if (resource === 'adGroupAds') {\n    if (typeof c.adGroup !== 'string' || !c.adGroup.startsWith(`customers/${customerId}/adGroups/`) || !/^\\d+$/.test(c.adGroup.split('/').pop())) return fail('invalid adGroup');\n    if (!['ENABLED', 'PAUSED'].includes(c.status) || !c.ad || typeof c.ad !== 'object' || Object.keys(c).length !== 3) return fail('invalid ad');\n    const ad = c.ad; const rsa = ad.responsiveSearchAd;\n    const assetOk = (a, max) => a && typeof a === 'object' && typeof a.text === 'string' && a.text.trim().length > 0 && a.text.length <= max && (a.pinnedField === undefined || /^(HEADLINE_[123]|DESCRIPTION_[12])$/.test(a.pinnedField)) && Object.keys(a).every((k) => k === 'text' || k === 'pinnedField');\n    if (!rsa || typeof rsa !== 'object' || !Array.isArray(rsa.headlines) || !Array.isArray(rsa.descriptions)) return fail('invalid responsive search ad');\n    if (rsa.headlines.length < 3 || rsa.headlines.length > 15 || !rsa.headlines.every((a) => assetOk(a, 30))) return fail('invalid headlines');\n    if (rsa.descriptions.length < 2 || rsa.descriptions.length > 4 || !rsa.descriptions.every((a) => assetOk(a, 90))) return fail('invalid descriptions');\n    if (!Array.isArray(ad.finalUrls) || !ad.finalUrls.length || !ad.finalUrls.every((u) => typeof u === 'string' && /^https:\\/\\/[^\\s]+$/.test(u))) return fail('invalid finalUrls');\n    const pathOk = (v) => v === undefined || (typeof v === 'string' && v.length <= 15 && !/[\\s\\/]/.test(v));\n    if (!pathOk(rsa.path1) || !pathOk(rsa.path2) || !Object.keys(ad).every((k) => k === 'responsiveSearchAd' || k === 'finalUrls') || !Object.keys(rsa).every((k) => ['headlines', 'descriptions', 'path1', 'path2'].includes(k))) return fail('invalid ad fields');\n    const build = { headlines: rsa.headlines.map((a) => a.pinnedField ? { text: a.text, pinnedField: a.pinnedField } : { text: a.text }), descriptions: rsa.descriptions.map((a) => a.pinnedField ? { text: a.text, pinnedField: a.pinnedField } : { text: a.text }) };\n    if (rsa.path1) build.path1 = rsa.path1; if (rsa.path2) build.path2 = rsa.path2;\n    operation = { create: { adGroup: c.adGroup, status: c.status, ad: { responsiveSearchAd: build, finalUrls: ad.finalUrls } } };\n  } else return fail('create not allowed on this resource');\n} else if (op.update && typeof op.update === 'object') {\n  const name = String(op.update.resourceName || '');\n  if (!name.startsWith(prefix) || !idRe.test(name.slice(prefix.length))) return fail('invalid resourceName');\n  if (!masks[resource].includes(op.updateMask)) return fail('updateMask not allowed');\n  const toCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());\n  const parts = op.updateMask.split('.').map(toCamel);\n  const keys = Object.keys(op.update).filter((k) => k !== 'resourceName');\n  if (keys.length !== 1 || keys[0] !== parts[0]) return fail('fields do not match updateMask');\n  let value = op.update[parts[0]];\n  if (parts.length === 2) {\n    if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || !(parts[1] in value)) return fail('fields do not match updateMask');\n    value = { [parts[1]]: value[parts[1]] };\n  } else if (value && typeof value === 'object') return fail('fields do not match updateMask');\n  if (/date_time$/.test(op.updateMask) && !/^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}$/.test(String(value))) return fail('invalid date');\n  operation = { update: { resourceName: name, [parts[0]]: value }, updateMask: op.updateMask };\n} else return fail('unknown operation');\nreturn [{ json: { valid: true, customerId, resource, payload: { operations: [operation], partialFailure: false } } }];",
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
