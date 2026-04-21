export const MCP_SERVER_WHITELIST = [
  "meta-ads-impulse",
  "mcp-google-ads",
  "mcp-google-analytics",
] as const;

export type McpServer = (typeof MCP_SERVER_WHITELIST)[number];

export function toolPatternForServer(server: string): string {
  return `mcp__${server}__*`;
}
