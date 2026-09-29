// ImpulseMotion → Routines (e-mail). Flux n8n À PUBLIER, au format du SDK de
// flux n8n (comme auto-alerts.workflow.js).
//
// Reçoit   POST …/webhook/impulsemotion-routines
//          en-tête X-Alert-Secret, corps { version: 1, kind: "email", to: [adresses], subject, text }
// Répond   200 { ok: true } une fois l'e-mail remis à Gmail,
//          200 { ok: false, error } si Gmail refuse, 400 demande invalide, 401 secret faux.
//
// Avant de publier, remplacer :
//   __SECRET__               le secret partagé (celui de N8N_ALERT_WEBHOOK_SECRET, ou un secret propre)
//   __GMAIL_CREDENTIAL_ID__  l'identifiant du compte Gmail expéditeur dans n8n (à choisir par le
//   __GMAIL_CREDENTIAL_NAME__ propriétaire ; « Gmail account 2 » est celui de data@impulse-analytics.com)
//
// Variables d'environnement à poser sur Vercel (application) :
//   N8N_ROUTINES_WEBHOOK_URL     adresse de production du webhook ci-dessus
//   N8N_ROUTINES_WEBHOOK_SECRET  le secret ; absent, l'application envoie N8N_ALERT_WEBHOOK_SECRET
//
// Les messages Slack des routines ne passent pas par ce flux : ils réutilisent
// le flux « impulsemotion-auto-alerts » déjà publié (kind: "digest").

const incoming = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Demande ImpulseMotion',
    parameters: { httpMethod: 'POST', path: 'impulsemotion-routines', responseMode: 'responseNode' },
  },
  output: [{ headers: { 'x-alert-secret': 'secret' }, body: { version: 1, kind: 'email', to: ['consultant@impulse-analytics.com'], subject: 'Objet', text: 'Message' } }],
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

// Second contrôle, indépendant de l'application : 5 destinataires au plus,
// adresses simples, objet sur une ligne, texte borné.
const check = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Contrôler la demande',
    parameters: {
      mode: 'runOnceForAllItems',
      language: 'javaScript',
      jsCode: "const body = $input.first().json.body || {};\nconst fail = (error) => [{ json: { valid: false, error } }];\nif (body.version !== 1 || body.kind !== 'email') return fail('unknown kind');\nconst to = Array.isArray(body.to) ? [...new Set(body.to.map((a) => String(a).trim().toLowerCase()))] : [];\nif (to.length < 1 || to.length > 5) return fail('1 to 5 recipients');\nconst re = /^[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9][a-z0-9.-]{0,251}\\.[a-z]{2,}$/;\nif (to.some((a) => a.length > 254 || !re.test(a))) return fail('invalid recipient');\nconst subject = String(body.subject || '').replace(/[\\r\\n\\t]+/g, ' ').trim().slice(0, 200);\nconst text = String(body.text || '').slice(0, 20000);\nif (!subject || !text.trim()) return fail('subject and text required');\nreturn [{ json: { valid: true, to: to.join(', '), subject, text } }];",
    },
  },
  output: [{ valid: true, to: 'consultant@impulse-analytics.com', subject: 'Objet', text: 'Message', error: '' }],
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

const sendMail = node({
  type: 'n8n-nodes-base.gmail',
  version: 2.2,
  config: {
    name: "Envoyer l'e-mail",
    parameters: {
      resource: 'message',
      operation: 'send',
      sendTo: expr('{{ $json.to }}'),
      subject: expr('{{ $json.subject }}'),
      emailType: 'text',
      message: expr('{{ $json.text }}'),
      options: { appendAttribution: false, senderName: 'ImpulseMotion' },
    },
    credentials: { gmailOAuth2: { id: '__GMAIL_CREDENTIAL_ID__', name: '__GMAIL_CREDENTIAL_NAME__' } },
    onError: 'continueRegularOutput',
  },
  output: [{ id: '18c0ffee', threadId: '18c0ffee', labelIds: ['SENT'] }],
});

const answer = node({
  type: 'n8n-nodes-base.respondToWebhook',
  version: 1.5,
  config: {
    name: 'Réponse',
    parameters: {
      respondWith: 'json',
      responseBody: expr('{{ JSON.stringify({ ok: !!$json.id, error: $json.id ? null : String($json.error?.message || $json.error || $json.message || "gmail_error").slice(0, 200) }) }}'),
      options: { responseCode: 200 },
    },
  },
  output: [{}],
});

export default workflow('impulsemotion-routines', 'ImpulseMotion → Routines (e-mail)')
  .add(incoming)
  .to(secretOk
    .onTrue(check.to(valid
      .onTrue(sendMail.to(answer))
      .onFalse(invalid)))
    .onFalse(refuse));
