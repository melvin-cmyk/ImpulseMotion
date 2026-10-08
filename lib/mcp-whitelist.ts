/**
 * Serveurs MCP attribuables aux UTILISATEURS (ACL admin, /api/admin/users/[id]/mcp)
 * et ouverts par défaut au staff sur /api/relay/chat.
 *
 * "client-data" (entrepôt e-commerce des bots clients) n'en fait volontairement
 * PAS partie : ce n'est pas une permission utilisateur mais un périmètre par
 * bot — le relay ne le démarre que si la requête porte `dataScope.clientKey`
 * (voir CLIENT_DATA_SERVER et server/relay.mjs, dont la whitelist est
 * distincte). L'ajouter ici ferait apparaître un choix sans objet dans l'admin.
 */
export const MCP_SERVER_WHITELIST = [
  "meta-ads-impulse",
  "mcp-google-ads",
  "mcp-google-analytics",
] as const;

export type McpServer = (typeof MCP_SERVER_WHITELIST)[number];

/**
 * HQ (mémoire de l'agence : skills, knowledge, projets, policies), en lecture
 * seule. Volontairement HORS de MCP_SERVER_WHITELIST : il porte l'identité
 * propriétaire de l'agence et couvre tous les clients, donc il n'est jamais
 * attribuable à un utilisateur client — seulement ajouté d'office pour le staff
 * (console /ai, copilote). Le relay le refuse à tout bot client.
 */
export const HQ_SERVER = "hq" as const;

/**
 * Google Sheets via n8n, en lecture seule (le relay ne laisse passer que les
 * outils de lecture). Le compte Google derrière est celui de l'agence : le
 * consultant partage sa feuille avec SHEETS_SHARE_EMAIL puis colle le lien.
 * Staff uniquement, comme HQ — jamais attribuable à un client.
 */
export const SHEETS_SERVER = "mcp-google-sheet" as const;
export const SHEETS_SHARE_EMAIL = process.env.NEXT_PUBLIC_SHEETS_SHARE_EMAIL || "data@impulse-analytics.com";

/**
 * Pseudo-serveur « web » : pas un MCP mais les outils intégrés du CLI
 * (recherche web + lecture d'URL), activés par le relay pour le staff
 * seulement — une page tierce est un vecteur d'injection, donc jamais pour un
 * bot client.
 */
export const WEB_SERVER = "web" as const;

/**
 * Bac à sable Python (server/mcp-sandbox.mjs) : un workspace par conversation
 * côté relay, staff uniquement. Hors de STAFF_MCP_SERVERS pour l'instant :
 * seules les surfaces qui savent afficher ses sorties (liens `sandbox:` →
 * /api/.../files) le demandent — le copilote dashboard aujourd'hui.
 */
export const SANDBOX_SERVER = "sandbox" as const;

/**
 * Google Workspace via le CLI officiel gws (server/mcp-gws.mjs) : Drive, Sheets,
 * Docs, Gmail, Calendar de l'identité partagée data@impulse-analytics.com, en
 * lecture et en écriture (l'écriture exige confirm_write, sur demande explicite
 * du consultant). Staff uniquement, comme HQ — jamais attribuable à un client.
 */
export const GWS_SERVER = "gws" as const;

/**
 * Notion de l'agence, par un serveur MCP n8n (config/mcp-claude.json). n8n
 * tient l'accès à Notion et non un compte Claude : Notion est donc là quel que
 * soit le compte qui répond. Lecture, et écritures qui ajoutent seulement
 * (liste dans server/relay.mjs). Staff uniquement, comme HQ — jamais
 * attribuable à un client.
 */
export const NOTION_SERVER = "notion" as const;

/**
 * TikTok Ads, par le serveur MCP n8n en lecture seule. Un seul jeton lit tous
 * les annonceurs de l'agence : le relay ne le sert que derrière son proxy de
 * périmètre (server/mcp-scoped-ads.mjs), sur les comptes de l'appelant.
 * Hors de MCP_SERVER_WHITELIST : il n'est pas attribuable à un utilisateur
 * (un identifiant TikTok saisi sur une fiche utilisateur n'est vérifié par
 * personne) ; un client y accède par son assistant, sur les comptes rattachés
 * à son dashboard (lib/tiktok-accounts.ts).
 */
export const TIKTOK_SERVER = "mcp-tiktok-ads" as const;

/**
 * Google Merchant Center, par le serveur MCP n8n « MCP Google Merchant Center »
 * (compte Google de l'agence, lecture seule : comptes, produits et statuts,
 * diagnostics, flux, rapports MCQL). Un seul accès lit tous les comptes
 * Merchant de l'agence : staff uniquement, jamais un bot client (le relay le
 * refuse). Un client y est rattaché par une source « merchant » de son
 * dashboard (lib/merchant-center.ts), lue par les rapports et le copilote.
 */
export const MERCHANT_SERVER = "mcp-merchant-center" as const;

/** Serveurs ouverts au staff (admin, consultant) sur l'IA interne. */
export const STAFF_MCP_SERVERS = [...MCP_SERVER_WHITELIST, TIKTOK_SERVER, HQ_SERVER, SHEETS_SERVER, WEB_SERVER, GWS_SERVER, NOTION_SERVER, MERCHANT_SERVER] as const;

/** Serveur MCP stdio des données e-commerce (server/mcp-client-data.mjs), scoped par le relay. */
export const CLIENT_DATA_SERVER = "client-data" as const;

export function toolPatternForServer(server: string): string {
  return `mcp__${server}__*`;
}
