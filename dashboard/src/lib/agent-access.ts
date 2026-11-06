/**
 * The address of this installation's MCP server and the command connecting Claude
 * Code to it with an agent access token (issue #1362) — what the profile's MCP tab
 * hands over together with a freshly issued token
 * (`components/profile/mcp-panel.tsx`).
 *
 * It is the very form `docs/mcp.md` ("Connecting a client") documents, and the two
 * must say the same thing: transport `http`, the server named `swarm`, this
 * installation's `/operator/mcp` endpoint, and the token in the `Authorization`
 * header.
 *
 * The URL is built from the dashboard's own origin, the way the worker install
 * command is (`./worker-install-command.ts`): on a deployed installation the
 * dashboard and the router's `/operator/*` routes share one origin. `VITE_API_URL`
 * is deliberately not used — it names the API server, which does not serve MCP.
 * Pure so it can be tested without a window.
 */

/** The path the router serves MCP at — `OPERATOR_MCP_ENDPOINT` in `src/router/operator-mcp.ts`. */
export const OPERATOR_MCP_PATH = '/operator/mcp';

/** The MCP server URL of the installation served from `origin`. */
export function mcpServerUrl(origin: string): string {
	return `${origin.replace(/\/+$/, '')}${OPERATOR_MCP_PATH}`;
}

/** The `claude mcp add` command registering this installation's MCP server with `token`. */
export function claudeCodeMcpCommand(serverUrl: string, token: string): string {
	return [
		`claude mcp add --transport http swarm ${serverUrl} \\`,
		`  --header "Authorization: Bearer ${token}"`,
	].join('\n');
}
