/**
 * The page a person sees when they open the hosted server's address in a web
 * browser. Without it they got "Not found" on / and 405 on /mcp, which reads as
 * "the server is down" to someone who pasted the connector URL into a tab.
 *
 * Only plain browser navigations get it: a GET to / or /mcp whose Accept asks
 * for text/html and not text/event-stream. MCP clients POST to /mcp, or GET it
 * with Accept: text/event-stream, so they never match and reach the MCP handler
 * exactly as before.
 */

export const CONNECTOR_URL = 'https://mcp.edgegap.com/mcp';
export const DOCS_URL = 'https://docs.edgegap.com/docs/mcp-integration';

export function wantsHelpPage(method: string, pathname: string, accept: string | null): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (pathname !== '/' && pathname !== '/mcp' && pathname !== '/mcp/') return false;
  const a = (accept ?? '').toLowerCase();
  return a.includes('text/html') && !a.includes('text/event-stream');
}

export function helpPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Edgegap MCP server</title>
<style>
  :root { color-scheme: light dark; --bg: #ffffff; --fg: #1a1a1f; --muted: #5b5b66; --card: #f3f3f6; --accent: #5b3df5; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111116; --fg: #ececf1; --muted: #a0a0ad; --card: #1d1d25; --accent: #9d8bff; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 48px 16px; }
  h1 { font-size: 1.6rem; margin: 0 0 8px; }
  p { margin: 0 0 16px; }
  .muted { color: var(--muted); }
  code { display: block; background: var(--card); padding: 12px 14px; border-radius: 8px; font: 15px/1.4 ui-monospace, Consolas, monospace; overflow-wrap: anywhere; margin: 0 0 16px; }
  a { color: var(--accent); }
  .button { display: inline-block; background: var(--accent); color: #fff; text-decoration: none; padding: 10px 16px; border-radius: 8px; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>Edgegap MCP server</h1>
  <p class="muted">This address is for AI assistants, not for web browsers.</p>
  <p>Add this URL as a custom connector or MCP server in Claude, ChatGPT, Cursor, VS Code or any other MCP client:</p>
  <code>${CONNECTOR_URL}</code>
  <p>You sign in with your Edgegap account the first time a tool needs it. Your assistant can then build, deploy and manage game servers and matchmakers on Edgegap.</p>
  <p><a class="button" href="${DOCS_URL}">Setup guide</a></p>
</main>
</body>
</html>
`;
}

export function helpPageResponse(method: string): Response {
  return new Response(method === 'HEAD' ? null : helpPageHtml(), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Accept',
    },
  });
}
