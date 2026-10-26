#!/usr/bin/env node
/**
 * Edgegap MCP server over Streamable HTTP, for self-hosting (Docker, a VM).
 *
 * The same stateless design as the Cloudflare Worker: no ambient credential,
 * the developer's token comes in on each request's Authorization header and is
 * discarded with it, and discovery (initialize, tools/list) works without one.
 * Read worker/DECISION.md before exposing this beyond a private network.
 *
 * Environment: PORT (default 8080), HOST (default 0.0.0.0), plus the same
 * EDGEGAP_* variables as the local server. EDGEGAP_API_TOKEN is ignored here.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, ConfigError } from './config.js';
import { EdgegapClient } from './client.js';
import { registerTools, serverInstructions } from './tools.js';
import { VERSION } from './version.js';
import { StaticTokenProvider } from './auth.js';
import { extractToken, unavailableMessage } from './hosted.js';

const MAX_BODY_BYTES = 1_000_000;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        reject(new Error('request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

function main(): void {
  let config;
  try {
    // No ambient credential, by design: every token comes from the request.
    config = { ...loadConfig(), envToken: undefined, transport: 'hosted' as const };
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`[edgegap-mcp] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const port = Number.parseInt(process.env.PORT ?? '8080', 10);
  const host = process.env.HOST ?? '0.0.0.0';

  const httpServer = createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');

    // Token-free, so health checks need no credential.
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }

    // startsWith, not strict equality: Streamable HTTP uses subpaths.
    if (!pathname.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }

    // Stateless: no sessions, so the GET stream and DELETE have nothing to attach to.
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJsonRpcError(res, 405, 'Method not allowed. This server is stateless; use POST.');
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJsonRpcError(res, 400, (err as Error).message);
      return;
    }

    const { token, problem } = extractToken(req.headers.authorization);
    const auth = new StaticTokenProvider(token, problem ? unavailableMessage(problem) : undefined, problem);

    const server = new McpServer(
      { name: 'edgegap', version: VERSION },
      { instructions: serverInstructions('hosted') }
    );
    const client = new EdgegapClient(config, auth, {
      clientName: () => server.server.getClientVersion()?.name,
    });
    registerTools(server, client, config, auth);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      // Never echo the error: HTTP layers sometimes include request headers.
      process.stderr.write(`[edgegap-mcp] request failed: ${(err as Error).name}\n`);
      if (!res.headersSent) sendJsonRpcError(res, 500, 'Internal server error');
    }
  });

  httpServer.listen(port, host, () => {
    process.stderr.write(`[edgegap-mcp] listening on http://${host}:${port}/mcp\n`);
  });

  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
