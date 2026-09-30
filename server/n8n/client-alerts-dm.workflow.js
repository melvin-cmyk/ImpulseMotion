// ImpulseMotion — private Slack messages of the client alerts. n8n workflow TO PUBLISH,
// written with the n8n Workflow SDK (like auto-alerts.workflow.js). Called by
// lib/client-alerts/slack-dm.ts.
//
// Receives  POST …/webhook/impulsemotion-dm
//           header X-Alert-Secret, body { version: 1, kind, … }
//   kind "lookup"  { email }              → users.lookupByEmail
//       200 { ok: true, user: { id, name } }   the member
//       200 { ok: true, user: null }           Slack answers users_not_found (or the member is deactivated)
//       200 { ok: false, error, needed }       any other Slack error (needed = the missing scope)
//   kind "dm"      { slackUserId, text }  → conversations.open (users = slackUserId), then chat.postMessage
//       200 { ok: true }
//       200 { ok: false, error, needed }       Slack refused to open the conversation or to post
//   400 { ok: false, error }   unknown kind, invalid address, slackUserId that is not a member (U… / W…),
//                              empty text or text over 4 000 characters
//   401 { ok: false, error: "unauthorized" }   wrong secret
//
// A private alert never lands in a channel: the recipient must be a member id, and the
// conversation Slack opens must be a direct one (D…) before anything is posted.
//
// Before publishing, replace:
//   __SECRET__   the shared secret (N8N_ALERT_WEBHOOK_SECRET)
//
// Slack application (credential « Slack lpev »): scopes users:read, users:read.email, im:write, chat:write.
//
// Environment of the application (Vercel): nothing new when N8N_ALERT_WEBHOOK_URL ends with
// /impulsemotion-alerts (the address is derived); otherwise N8N_DM_WEBHOOK_URL.

const incoming = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Demande ImpulseMotion',
    parameters: { httpMethod: 'POST', path: 'impulsemotion-dm', responseMode: 'responseNode' },
  },
  output: [{ headers: { 'x-alert-secret': 'secret' }, body: { version: 1, kind: 'dm', email: 'consultant@impulse-analytics.com', slackUserId: 'U0123456789', text: 'message' } }],
});

const secretOk = ifElse({
  version: 2.3,
  config: {
    name: 'Secret valide ?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.headers["x-alert-secret"] }}'), rightValue: '__SECRET__', operator: { type: 'string', operation: 'equals' } }],
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
      jsCode: "const body = $input.first().json.body || {};\nconst fail = (error) => [{ json: { valid: false, error } }];\nif (body.version !== 1) return fail('unknown version');\nif (body.kind === 'lookup') {\n  const email = String(body.email || '').trim().toLowerCase();\n  const re = /^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9][a-z0-9.-]{0,251}\\.[a-z]{2,}$/;\n  if (email.length > 254 || !re.test(email)) return fail('invalid email');\n  return [{ json: { valid: true, kind: 'lookup', email } }];\n}\nif (body.kind === 'dm') {\n  const slackUserId = typeof body.slackUserId === 'string' ? body.slackUserId : '';\n  if (!/^[UW][A-Z0-9]{8,20}$/.test(slackUserId)) return fail('slackUserId must be a member id');\n  const text = typeof body.text === 'string' ? body.text : '';\n  if (!text.trim()) return fail('text required');\n  if (text.length > 4000) return fail('text too long');\n  return [{ json: { valid: true, kind: 'dm', slackUserId, text } }];\n}\nreturn fail('unknown kind');",
    },
  },
  output: [{ valid: true, kind: 'dm', email: 'consultant@impulse-analytics.com', slackUserId: 'U0123456789', text: 'message', error: '' }],
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

const isLookup = ifElse({
  version: 2.3,
  config: {
    name: 'Recherche ou message ?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.kind }}'), rightValue: 'lookup', operator: { type: 'string', operation: 'equals' } }],
        combinator: 'and',
      },
    },
  },
});

const lookupByEmail = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Chercher le membre par e-mail',
    parameters: {
      method: 'GET',
      url: 'https://slack.com/api/users.lookupByEmail',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'slackApi',
      sendQuery: true,
      specifyQuery: 'keypair',
      queryParameters: { parameters: [{ name: 'email', value: expr('{{ $json.email }}') }] },
      options: { response: { response: { neverError: true } } },
    },
    credentials: { slackApi: { id: '5SbuTxJH0Up2rnnP', name: 'Slack lpev' } },
    onError: 'continueRegularOutput',
  },
  output: [{ ok: true, user: { id: 'U0123456789', name: 'consultant', real_name: 'Consultant Impulse', deleted: false, profile: { real_name: 'Consultant Impulse' } }, error: '', needed: '' }],
});

const answerLookup = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Réponse recherche',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify($json.ok === true && $json.user?.id ? { ok: true, user: $json.user.deleted === true ? null : { id: $json.user.id, name: $json.user.real_name || $json.user.profile?.real_name || $json.user.name || null } } : $json.error === "users_not_found" ? { ok: true, user: null } : { ok: false, error: typeof $json.error === "string" && $json.error ? $json.error : ($json.error?.message || ($json.message ? String($json.message) : "slack_error")), needed: $json.needed || null }) }}'),
      options: { responseCode: 200 },
    },
  },
  output: [{}],
});

const openConversation = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Ouvrir la conversation privée',
    parameters: {
      method: 'POST',
      url: 'https://slack.com/api/conversations.open',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'slackApi',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ users: $json.slackUserId }) }}'),
      options: { response: { response: { neverError: true } } },
    },
    credentials: { slackApi: { id: '5SbuTxJH0Up2rnnP', name: 'Slack lpev' } },
    onError: 'continueRegularOutput',
  },
  output: [{ ok: true, channel: { id: 'D0123456789' }, error: '', needed: '' }],
});

const opened = ifElse({
  version: 2.3,
  config: {
    name: 'Conversation privée ouverte ?',
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ leftValue: expr('{{ $json.ok === true && String($json.channel?.id || "").startsWith("D") }}'), rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
        combinator: 'and',
      },
    },
  },
});

const notOpened = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Réponse conversation refusée',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ ok: false, error: $json.ok === true ? "not_a_direct_conversation" : (typeof $json.error === "string" && $json.error ? $json.error : ($json.error?.message || ($json.message ? String($json.message) : "slack_error"))), needed: $json.needed || null }) }}'),
      options: { responseCode: 200 },
    },
  },
  output: [{}],
});

const postMessage = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Envoyer le message privé',
    parameters: {
      method: 'POST',
      url: 'https://slack.com/api/chat.postMessage',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'slackApi',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ channel: $json.channel.id, text: $("Contrôler la demande").first().json.text, mrkdwn: true, unfurl_links: false, unfurl_media: false }) }}'),
      options: { response: { response: { neverError: true } } },
    },
    credentials: { slackApi: { id: '5SbuTxJH0Up2rnnP', name: 'Slack lpev' } },
    onError: 'continueRegularOutput',
  },
  output: [{ ok: true, channel: 'D0123456789', ts: '1.2', error: '', needed: '' }],
});

const answerMessage = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Réponse message',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify($json.ok === true ? { ok: true } : { ok: false, error: typeof $json.error === "string" && $json.error ? $json.error : ($json.error?.message || ($json.message ? String($json.message) : "slack_error")), needed: $json.needed || null }) }}'),
      options: { responseCode: 200 },
    },
  },
  output: [{}],
});

export default workflow('impulsemotion-dm', 'ImpulseMotion — messages privés (alertes)')
  .add(incoming)
  .to(secretOk
    .onTrue(check.to(valid
      .onTrue(isLookup
        .onTrue(lookupByEmail.to(answerLookup))
        .onFalse(openConversation.to(opened
          .onTrue(postMessage.to(answerMessage))
          .onFalse(notOpened))))
      .onFalse(invalid)))
    .onFalse(refuse));
