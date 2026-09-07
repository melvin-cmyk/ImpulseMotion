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

/** Serveur MCP stdio des données e-commerce (server/mcp-client-data.mjs), scoped par le relay. */
export const CLIENT_DATA_SERVER = "client-data" as const;

export function toolPatternForServer(server: string): string {
  return `mcp__${server}__*`;
}
