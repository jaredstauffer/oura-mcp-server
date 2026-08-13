import { startHttpServer, RunningServer, TEST_PASSWORD } from './helpers/server.js';
import {
  authorizeFully,
  beginAuthorization,
  exchangeCode,
  mcpRequest,
  pkcePair,
  registerClient,
  submitLogin,
  REDIRECT_URI
} from './helpers/oauth.js';


describe('hosted mode OAuth', () => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await startHttpServer();
  });

  afterAll(() => {
    server?.stop();
  });

  describe('discovery', () => {
    it('advertises authorization server metadata', async () => {
      const metadata = await (await fetch(`${server.baseUrl}/.well-known/oauth-authorization-server`)).json();

      expect(metadata.authorization_endpoint).toBe(`${server.baseUrl}/authorize`);
      expect(metadata.token_endpoint).toBe(`${server.baseUrl}/token`);
      expect(metadata.registration_endpoint).toBeTruthy();
    });

    it('advertises protected resource metadata for /mcp', async () => {
      const response = await fetch(`${server.baseUrl}/.well-known/oauth-protected-resource/mcp`);
      const metadata = await response.json();

      expect(response.status).toBe(200);
      expect(metadata.resource).toBe(`${server.baseUrl}/mcp`);
    });

    it('reports healthy', async () => {
      const body = await (await fetch(`${server.baseUrl}/healthz`)).json();
      expect(body).toEqual({ status: 'ok' });
    });
  });

  describe('access control', () => {
    it('rejects an unauthenticated MCP call and points at the metadata', async () => {
      const { status, body } = await mcpRequest(server.baseUrl, undefined, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
      });

      expect(status).toBe(401);
      expect(body.error).toBe('invalid_token');
    });

    it('rejects a forged bearer token', async () => {
      const { status } = await mcpRequest(server.baseUrl, 'not-a-real-token', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
      });

      expect(status).toBe(401);
    });

    it('rejects the wrong password', async () => {
      const { client_id: clientId } = await registerClient(server.baseUrl);
      const { challenge } = pkcePair();
      const { loginRequest } = await beginAuthorization(server.baseUrl, clientId, challenge);

      const response = await submitLogin(server.baseUrl, loginRequest!, 'wrong-password');

      expect(response.status).toBe(401);
      expect(response.headers.get('location')).toBeNull();
    });
  });

  describe('authorization code flow', () => {
    it('registers a client dynamically', async () => {
      const client = await registerClient(server.baseUrl);
      expect(typeof client.client_id).toBe('string');
      expect(client.client_id.length).toBeGreaterThan(0);
    });

    it('renders a login form from /authorize', async () => {
      const { client_id: clientId } = await registerClient(server.baseUrl);
      const { challenge } = pkcePair();

      const { status, loginRequest } = await beginAuthorization(server.baseUrl, clientId, challenge);

      expect(status).toBe(200);
      expect(loginRequest).toBeTruthy();
    });

    it('redirects back with a code and preserves state', async () => {
      const { client_id: clientId } = await registerClient(server.baseUrl);
      const { challenge } = pkcePair();
      const { loginRequest } = await beginAuthorization(server.baseUrl, clientId, challenge, 'state-abc');

      const response = await submitLogin(server.baseUrl, loginRequest!, TEST_PASSWORD);
      const location = new URL(response.headers.get('location')!);

      expect(response.status).toBe(302);
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(location.searchParams.get('code')).toBeTruthy();
      expect(location.searchParams.get('state')).toBe('state-abc');
    });

    it('rejects a code presented with the wrong PKCE verifier', async () => {
      const { client_id: clientId } = await registerClient(server.baseUrl);
      const { challenge } = pkcePair();
      const { loginRequest } = await beginAuthorization(server.baseUrl, clientId, challenge);
      const login = await submitLogin(server.baseUrl, loginRequest!, TEST_PASSWORD);
      const code = new URL(login.headers.get('location')!).searchParams.get('code')!;

      const { verifier: wrongVerifier } = pkcePair();
      const { status } = await exchangeCode(server.baseUrl, clientId, code, wrongVerifier);

      expect(status).toBeGreaterThanOrEqual(400);
    });

    it('exchanges a code for tokens', async () => {
      const { tokens } = await authorizeFully(server.baseUrl, TEST_PASSWORD);

      expect(tokens.access_token).toBeTruthy();
      expect(tokens.refresh_token).toBeTruthy();
      expect(tokens.token_type).toBe('Bearer');
      expect(tokens.expires_in).toBe(3600);
      expect(tokens.scope).toBe('oura:read');
    });

    it('refuses to redeem the same code twice', async () => {
      const { client_id: clientId } = await registerClient(server.baseUrl);
      const { verifier, challenge } = pkcePair();
      const { loginRequest } = await beginAuthorization(server.baseUrl, clientId, challenge);
      const login = await submitLogin(server.baseUrl, loginRequest!, TEST_PASSWORD);
      const code = new URL(login.headers.get('location')!).searchParams.get('code')!;

      const first = await exchangeCode(server.baseUrl, clientId, code, verifier);
      const second = await exchangeCode(server.baseUrl, clientId, code, verifier);

      expect(first.status).toBe(200);
      expect(second.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('authenticated MCP access', () => {
    it('completes initialize and lists tools', async () => {
      const { tokens } = await authorizeFully(server.baseUrl, TEST_PASSWORD);

      const init = await mcpRequest(server.baseUrl, tokens.access_token, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
      });

      expect(init.status).toBe(200);
      expect(init.body.result.serverInfo.name).toBe('oura-provider');

      const tools = await mcpRequest(server.baseUrl, tokens.access_token, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
      });

      expect(tools.body.result.tools).toHaveLength(13);
    });

    it('issues a working access token from a refresh token', async () => {
      const { clientId, tokens } = await authorizeFully(server.baseUrl, TEST_PASSWORD);

      const refreshed = await (
        await fetch(`${server.baseUrl}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh_token,
            client_id: clientId
          })
        })
      ).json();

      expect(refreshed.access_token).toBeTruthy();
      expect(refreshed.access_token).not.toBe(tokens.access_token);

      const call = await mcpRequest(server.baseUrl, refreshed.access_token, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list'
      });

      expect(call.status).toBe(200);
      expect(call.body.result.tools.length).toBeGreaterThan(0);
    });

    it('refuses GET and DELETE on /mcp in stateless mode', async () => {
      const { tokens } = await authorizeFully(server.baseUrl, TEST_PASSWORD);
      const headers = { authorization: `Bearer ${tokens.access_token}` };

      const get = await fetch(`${server.baseUrl}/mcp`, { headers });
      const del = await fetch(`${server.baseUrl}/mcp`, { method: 'DELETE', headers });

      expect(get.status).toBe(405);
      expect(del.status).toBe(405);
    });
  });
});
