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

/** Serveurs ouverts au staff (admin, consultant) sur l'IA interne. */
export const STAFF_MCP_SERVERS = [...MCP_SERVER_WHITELIST, HQ_SERVER] as const;

/** Serveur MCP stdio des données e-commerce (server/mcp-client-data.mjs), scoped par le relay. */
export const CLIENT_DATA_SERVER = "client-data" as const;

export function toolPatternForServer(server: string): string {
  return `mcp__${server}__*`;
}
