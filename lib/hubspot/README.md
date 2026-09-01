# Connecteur HubSpot (lib/hubspot)

Lecture seule du CRM HubSpot d'un client via l'API REST (`https://api.hubapi.com`) avec le token
d'une **application privée** propre à ce client. Sert la carte « Sources & attribution », les widgets
`crm_*` et la section CRM du rapport IA.

## Créer le token chez le client

1. Dans HubSpot : **Paramètres (roue crantée) → Intégrations → Applications privées → Créer une application privée**.
2. Onglet *Informations de base* : nom « ImpulseMotion – reporting » (lecture seule).
3. Onglet *Étendues* (scopes), cocher uniquement :
   - `crm.objects.contacts.read`
   - `crm.objects.deals.read`
   - `crm.schemas.deals.read` (pipelines et étapes de deals)
   - `crm.schemas.contacts.read` (liste des propriétés, pour détecter `utm_campaign`)
4. Créer l'application, copier le token (`pat-eu1-…` / `pat-na1-…`) et le coller dans ImpulseMotion
   (Dashboard → Sources → HubSpot). Le token est testé (`testHubspotConnection`) puis chiffré en base ;
   il n'est jamais renvoyé au navigateur.

`testHubspotConnection` renvoie `missingScopes` : la liste exacte à cocher si un scope manque.

## Ce qui est lu

| Étape | Endpoint | Usage |
|---|---|---|
| Identité | `GET /account-info/v3/details` | `portalId`, `uiDomain`, `timeZone` (bornes de période) |
| Propriétés | `GET /crm/v3/properties/contacts` | détection des propriétés `utm_campaign` / `utm_source` / `utm_medium` / `utm_content` (ou `hs_utm_*`, ou nom/label contenant « utm campaign ») |
| Contacts | `POST /crm/v3/objects/contacts/search` | contacts **créés** dans la période (`createdate` BETWEEN), 200 par page |
| Deals | `POST /crm/v3/objects/deals/search` | deals créés dans la période **et** deals gagnés dans la période (`closedate` + `hs_is_closed_won`) |
| Associations | `POST /crm/v4/associations/deals/contacts/batch/read` | source/campagne d'un deal = celle de son premier contact associé (lots de 100) |
| Contacts liés | `POST /crm/v3/objects/contacts/batch/read` | contacts associés à un deal mais créés avant la période |
| Pipelines | `GET /crm/v3/pipelines/deals` | libellés d'étapes, gagné (`probability = 1.0`) / fermé |

Bornes : `since 00:00:00` → `until 23:59:59.999` dans la timezone passée en entrée, sinon celle du
portail HubSpot, sinon UTC.

## Attribution

- **Source** (`hs_analytics_source`, repli `hs_latest_source`) : `PAID_SOCIAL`, `PAID_SEARCH`, `ORGANIC_SEARCH`, … → niveau 1.
- **Campagne** d'un contact, dans l'ordre : propriété UTM détectée (ou `config.utmCampaignProperty`)
  → `utm_campaign` parsé dans `hs_analytics_first_url` → `hs_analytics_source_data_2` (sources payantes seulement).
- **Rapprochement** avec les campagnes Meta/Google connues : égalité insensible à la casse / accents /
  espaces / ponctuation, ou égalité sur l'id de campagne, puis inclusion (≥ 4 caractères). Pas de fuzzy.
- **Qualifié** : `lifecyclestage ∈ {marketingqualifiedlead, salesqualifiedlead, opportunity, customer}` ;
  si `config.qualifiedStageIds` est renseigné, un contact est qualifié quand l'un de ses deals atteint
  une de ces étapes (ou est gagné).
- **Diagnostic** : niveau 0 (aucun contact / aucune source), 1 (sources connues), 2 (≥ 30 % des contacts
  payants rattachés à une campagne connue) + recommandations en français.
- **Devise** : `deal_currency_code` majoritaire, sinon `config.currency`, sinon `null`. Jamais devinée.

## Fiabilité

- `hubspotFetch` : timeout 25 s, 4 tentatives avec backoff exponentiel sur 429 / 5xx / réseau
  (respecte `Retry-After`), sémaphore `HUBSPOT_MAX_CONCURRENCY` (défaut 3), espacement des appels
  `/search` (`HUBSPOT_SEARCH_MIN_INTERVAL_MS`, défaut 260 ms, l'API search est limitée à ~4 req/s).
- Erreurs typées `HubspotApiError { status, category, retryable, missingScopes }` ;
  `userMessage()` donne le texte français à afficher.
- Un 401 ou un échec de la recherche contacts **propage** l'erreur (rien n'est mis en cache).
  Tout le reste (propriétés, deals, associations, pipelines) dégrade en `warnings[]` + `partial: true`.
- Cache : `getCrmSnapshotCached` → `cached()` de `lib/kpi-cache`, clé
  `hubspot:snapshot:<dashboardId>:<since>_<until>:<hash config+campagnes>`, TTL `ttlForRange`.

## Limites connues

- L'API search plafonne à **10 000 résultats** par requête : au-delà, `partial: true` et un warning
  demandent de réduire la période (pas de découpage automatique pour l'instant).
- Le premier contact associé au deal donne l'attribution ; les deals sans contact sont comptés en
  source « Inconnue ».
- `hs_analytics_first_url` n'est renseigné que si le code de suivi HubSpot est installé sur le site ;
  sans propriété `utm_campaign` ni suivi, seul le niveau 1 (par source) est possible.
- Les montants de deals sont lus tels quels (`amount`) dans la devise du deal ; aucune conversion.
- `byCampaign` est limité à 100 lignes (tri : contacts décroissants).
