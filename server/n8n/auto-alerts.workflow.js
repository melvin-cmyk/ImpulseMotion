const incoming = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Demande ImpulseMotion',
    parameters: { httpMethod: 'POST', path: 'impulsemotion-auto-alerts', responseMode: 'responseNode' },
  },
  output: [{ headers: { 'x-alert-secret': 'secret' }, body: { version: 1, kind: 'digest', channel: 'C0123456789', text: 'message', prefix: 'c_', client: { id: 'id', name: 'Client' } } }],
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

const route = switchCase({
  version: 3.4,
  config: {
    name: 'Quelle demande ?',
    parameters: {
      mode: 'rules',
      rules: {
        values: [
          { outputKey: 'digest', renameOutput: true, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ leftValue: expr('{{ $json.body.kind }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'digest' }], combinator: 'and' } },
          { outputKey: 'channels', renameOutput: true, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ leftValue: expr('{{ $json.body.kind }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'channels' }], combinator: 'and' } },
          { outputKey: 'join', renameOutput: true, conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ leftValue: expr('{{ $json.body.kind }}'), operator: { type: 'string', operation: 'equals' }, rightValue: 'join' }], combinator: 'and' } },
        ],
      },
      options: { fallbackOutput: 'extra', renameFallbackOutput: 'inconnue' },
    },
  },
});

const postMessage = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Poster le bilan dans Slack',
    parameters: {
      method: 'POST',
      url: 'https://slack.com/api/chat.postMessage',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'slackApi',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ channel: $json.body.channel, text: $json.body.text, mrkdwn: true, unfurl_links: false, unfurl_media: false }) }}'),
      options: { response: { response: { neverError: true } } },
    },
    credentials: { slackApi: { id: '5SbuTxJH0Up2rnnP', name: 'Slack lpev' } },
    onError: 'continueRegularOutput',
  },
  output: [{ ok: true, channel: 'C0123456789', ts: '1.2', error: '' }],
});

const joinChannel = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Rejoindre le canal',
    parameters: {
      method: 'POST',
      url: 'https://slack.com/api/conversations.join',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'slackApi',
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr('{{ JSON.stringify({ channel: $json.body.channel }) }}'),
      options: { response: { response: { neverError: true } } },
    },
    credentials: { slackApi: { id: '5SbuTxJH0Up2rnnP', name: 'Slack lpev' } },
    onError: 'continueRegularOutput',
  },
  output: [{ ok: true, error: '' }],
});

const answerSlack = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Réponse Slack',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ ok: $json.ok === true, error: $json.ok === true ? null : ($json.error || ($json.message ? String($json.message) : "slack_error")), needed: $json.needed || null }) }}'),
      options: { responseCode: 200 },
    },
  },
  output: [{}],
});

const listChannels = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.2,
  config: {
    name: 'Lister les canaux Slack',
    parameters: {
      method: 'GET',
      url: 'https://slack.com/api/conversations.list',
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'slackApi',
      sendQuery: true,
      specifyQuery: 'keypair',
      queryParameters: {
        parameters: [
          { name: 'types', value: 'public_channel,private_channel' },
          { name: 'exclude_archived', value: 'true' },
          { name: 'limit', value: '1000' },
        ],
      },
      options: {
        response: { response: { neverError: true } },
        pagination: {
          pagination: {
            paginationMode: 'updateAParameterInEachRequest',
            parameters: { parameters: [{ type: 'qs', name: 'cursor', value: expr('{{ $response.body.response_metadata?.next_cursor || "" }}') }] },
            paginationCompleteWhen: 'other',
            completeExpression: expr('{{ !$response.body.ok || !($response.body.response_metadata?.next_cursor) }}'),
            limitPagesFetched: true,
            maxRequests: 20,
          },
        },
      },
    },
    credentials: { slackApi: { id: '5SbuTxJH0Up2rnnP', name: 'Slack lpev' } },
    onError: 'continueRegularOutput',
  },
  output: [{ ok: true, channels: [{ id: 'C0123456789', name: 'c_client', is_private: false, is_member: true }], error: '', needed: '' }],
});

const keepClientChannels = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Garder les canaux clients',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const body = $('Demande ImpulseMotion').first().json.body || {};\nconst prefix = String(body.prefix || 'c_');\nconst channels = [];\nlet error = null;\nlet needed = null;\nfor (const item of $input.all()) {\n  const page = item.json || {};\n  if (page.ok !== true) { error = page.error || 'slack_error'; needed = page.needed || null; continue; }\n  for (const c of page.channels || []) {\n    if (!String(c.name || '').startsWith(prefix)) continue;\n    channels.push({ id: c.id, name: c.name, isPrivate: c.is_private === true, isMember: c.is_member === true });\n  }\n}\nconst ok = error === null || channels.length > 0;\nreturn [{ json: { ok, error: ok ? null : error, needed, channels } }];",
    },
  },
  output: [{ ok: true, error: null, needed: null, channels: [{ id: 'C0123456789', name: 'c_client', isPrivate: false, isMember: true }] }],
});

const answerChannels = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: { name: 'Réponse canaux', parameters: { respondWith: 'firstIncomingItem', options: { responseCode: 200 } } },
  output: [{}],
});

const unknownKind = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: { name: 'Demande inconnue 400', parameters: { respondWith: 'json', responseBody: '{"ok": false, "error": "unknown kind"}', options: { responseCode: 400 } } },
  output: [{}],
});

export default workflow('impulsemotion-auto-alerts', 'ImpulseMotion → Alertes automatiques (Slack clients c_)')
  .add(incoming)
  .to(secretOk
    .onTrue(route
      .onCase(0, postMessage.to(answerSlack))
      .onCase(1, listChannels.to(keepClientChannels.to(answerChannels)))
      .onCase(2, joinChannel.to(answerSlack))
      .onCase(3, unknownKind))
    .onFalse(refuse));
