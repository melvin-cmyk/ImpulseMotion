/**
 * Connecteurs des dashboards du staff : nom libre du consultant (« n8n google
 * ads », « mcp facebook »…) → serveur MCP du relay. Sans dépendance : importé
 * aussi côté navigateur (validation des propositions du copilote), là où
 * model.ts, qui embarque les modèles générés, serait trop lourd.
 */

export const DATASET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const CONNECTORS: Array<{ match: RegExp; server: string }> = [
  { match: /^(mcp-google-ads|google[ -]?ads|n8n[ -]*google[ -]*ads|gads)$/i, server: "mcp-google-ads" },
  { match: /^(meta-ads-impulse|meta|facebook|mcp[ -]*facebook|meta[ -]*ads|n8n[ -]*meta)$/i, server: "meta-ads-impulse" },
  { match: /^(mcp-google-sheet|google[ -]*sheets?|n8n[ -]*google[ -]*spre?e?a?dsheets?|sheets?)$/i, server: "mcp-google-sheet" },
  { match: /^(mcp-google-analytics|ga4|google[ -]*analytics|n8n[ -]*ga4)$/i, server: "mcp-google-analytics" },
  { match: /^(mcp-tiktok-ads|tiktok|tiktok[ -]*ads|n8n[ -]*tiktok)$/i, server: "mcp-tiktok-ads" },
  { match: /^(mcp-merchant-center|merchant|merchant[ -]*center)$/i, server: "mcp-merchant-center" },
];

export function connectorServer(connector: string): string | null {
  const c = connector.trim().replace(/\s+/g, " ");
  for (const { match, server } of CONNECTORS) if (match.test(c)) return server;
  return null;
}

/**
 * Outils ouverts aux jeux de données (= DIRECT_TOOL_ALLOWLIST du relay,
 * server/relay.mjs — lecture seule, appel direct sans IA) et forme de leurs
 * arguments, telle que le copilote doit l'écrire.
 */
export const DATASET_TOOLS: Array<{ server: string; connector: string; tools: string[]; args: string }> = [
  {
    server: "mcp-google-ads", connector: "n8n google ads",
    tools: ["Custom_GAQL_Query", "List_Customers", "Get_Campaigns", "Campaign_Performance", "AdGroup_Performance", "Ads_Performance", "Keywords_Performance", "Search_Terms", "Audience_Performance", "Geo_Performance", "Device_Performance", "Daily_Performance", "Conversion_Actions", "List_Conversion_Actions", "Budget_Info"],
    args: "Custom_GAQL_Query : { customer_id: \"1234567890\" (sans tirets), gaql_query: \"SELECT … FROM campaign WHERE segments.date DURING THIS_MONTH … LIMIT n\" } → réponse [{ results: [{ campaign: { name }, metrics: { costMicros, … }, segments: { date } }] }] (clés en camelCase, coûts en micros). Les autres outils prennent customer_id et, selon l'outil, date_range / start_date / end_date.",
  },
  {
    server: "meta-ads-impulse", connector: "mcp facebook",
    tools: ["List_Ad_Accounts1", "Get_Campaigns1", "Get_AdSets_Structure1", "Get_Ad_Creatives1", "Account_Overview1", "Campaign_Performance1", "AdSet_Performance1", "Ad_Performance1", "Daily_Performance1", "Campaign_Daily_Trend1", "Conversion_Funnel1", "Age_Gender_Breakdown1", "Device_Breakdown1", "Country_Breakdown1", "Placement_Breakdown1"],
    args: "un seul argument input = CHAÎNE JSON, ex. Campaign_Performance1 : { input: \"{\\\"ad_account_id\\\":\\\"act_123\\\",\\\"fields\\\":\\\"campaign_name,spend,purchase_roas\\\",\\\"level\\\":\\\"campaign\\\",\\\"date_preset\\\":\\\"this_month\\\",\\\"time_range\\\":\\\"\\\",\\\"limit\\\":\\\"200\\\",\\\"filtering\\\":\\\"[]\\\"}\" } ; Campaign_Daily_Trend1 ajoute \\\"time_increment\\\":\\\"1\\\" (une ligne par jour, champ date_start) ; Get_Campaigns1 : fields, limit, filtering (effective_status). Réponse { data: [ … ] } ou tableau.",
  },
  {
    server: "mcp-google-sheet", connector: "n8n google spreedsheet",
    tools: ["Get_row_s_in_sheet_in_Google_Sheets", "search_sheet"],
    args: "Get_row_s_in_sheet_in_Google_Sheets : { Document: \"<id du classeur, entre /d/ et /edit>\", Sheet: \"<nom de l'onglet>\" } → tableau de lignes { row_number, <en-têtes de colonnes> } (valeurs en texte ; l'en-tête est la 1re ligne de l'onglet). Le classeur doit être partagé avec data@impulse-analytics.com.",
  },
  {
    server: "mcp-google-analytics", connector: "ga4",
    tools: ["run_report", "run_pivot_report", "run_realtime_report", "get_property", "list_properties", "list_key_events", "get_metadata"],
    args: "run_report : { property_id, date_ranges: [{ start_date, end_date }], dimensions: [{ name }], metrics: [{ name }], limit } (API Data GA4).",
  },
  {
    server: "mcp-tiktok-ads", connector: "tiktok",
    tools: ["get_advertiser_info", "get_campaigns", "get_adgroups", "get_ads", "get_report_integrated", "list_business_centers", "list_bc_advertisers"],
    args: "get_report_integrated : { input: \"{\\\"advertiser_id\\\":\\\"…\\\",\\\"start_date\\\":\\\"AAAA-MM-JJ\\\",\\\"end_date\\\":\\\"AAAA-MM-JJ\\\",\\\"data_level\\\":\\\"AUCTION_CAMPAIGN\\\",\\\"dimensions\\\":[\\\"campaign_id\\\",\\\"stat_time_day\\\"]}\" } (30 jours au plus par appel ; métriques fixées par le relay).",
  },
  {
    server: "mcp-merchant-center", connector: "merchant",
    tools: ["list_merchant_accounts", "list_subaccounts", "get_account_issues", "list_data_sources", "search_reports", "list_products"],
    args: "search_reports : { account_id, query: \"SELECT … FROM product_performance_view WHERE date BETWEEN '…' AND '…'\" } (MCQL).",
  },
];
