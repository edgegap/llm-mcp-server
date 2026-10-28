/**
 * The server version, reported to MCP clients, in the User-Agent on every API
 * call, and by edgegap_context. Keep in step with package.json and server.json;
 * test/package.mjs fails the build when they disagree.
 */
export const VERSION = '0.15.0';
