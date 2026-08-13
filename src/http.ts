import { config as dotenvConfig } from 'dotenv';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { SingleUserOAuthProvider } from './auth/oauth_provider.js';
import { createOuraProvider, requireEnv } from './config.js';

dotenvConfig();

const SCOPES = ['oura:read'];

async function main() {
  const publicUrl = new URL(
    requireEnv('PUBLIC_URL', 'Set it to the deployment\'s public https origin, e.g. https://oura-mcp.up.railway.app')
  );
  const signingSecret = requireEnv('OAUTH_SIGNING_SECRET', 'Generate one with: openssl rand -hex 32');
  const password = requireEnv('MCP_AUTH_PASSWORD', 'This is the password you type when connecting Claude.');

  // Fail fast on missing Oura credentials rather than at the first tool call.
  createOuraProvider();

  const mcpUrl = new URL('/mcp', publicUrl);
  const oauthProvider = new SingleUserOAuthProvider(signingSecret, password, SCOPES);

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.urlencoded({ extended: false }));

  // Must be mounted at the root: it serves the /.well-known discovery documents
  // that Claude fetches before it will offer to connect.
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: publicUrl,
      resourceServerUrl: mcpUrl,
      resourceName: 'Oura Ring',
      scopesSupported: SCOPES
    })
  );

  app.post('/login', oauthProvider.handleLogin);

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const authenticate = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: SCOPES,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl)
  });

  app.post('/mcp', authenticate, express.json(), async (req, res) => {
    // One server and transport per request. Stateless mode means no session
    // affinity, so a redeploy or a second instance can't strand a conversation.
    const server = createOuraProvider().getServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  });

  // Stateless mode supports neither the SSE stream nor session teardown.
  const methodNotAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This server runs in stateless mode.' },
      id: null
    });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, '0.0.0.0', () => {
    console.error(`Oura MCP server listening on port ${port}, advertising ${mcpUrl.href}`);
  });
}

main().catch(error => {
  console.error('Server error:', error);
  process.exit(1);
});
