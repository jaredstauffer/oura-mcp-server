import { createHash, randomBytes } from 'node:crypto';

export const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

const base64url = (value: Buffer): string => value.toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export async function registerClient(baseUrl: string): Promise<{ client_id: string }> {
  const response = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test Client',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token']
    })
  });

  return response.json() as Promise<{ client_id: string }>;
}

/** Runs /authorize and pulls the signed request out of the rendered form. */
export async function beginAuthorization(
  baseUrl: string,
  clientId: string,
  challenge: string,
  state = 'test-state'
): Promise<{ status: number; loginRequest?: string }> {
  const url = new URL(`${baseUrl}/authorize`);
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'oura:read',
    state
  }).toString();

  const response = await fetch(url);
  const html = await response.text();
  const match = html.match(/name="login_request" value="([^"]+)"/);

  return { status: response.status, loginRequest: match?.[1] };
}

export async function submitLogin(
  baseUrl: string,
  loginRequest: string,
  password: string
): Promise<Response> {
  return fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ login_request: loginRequest, password })
  });
}

export async function exchangeCode(
  baseUrl: string,
  clientId: string,
  code: string,
  verifier: string
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier
    })
  });

  return { status: response.status, body: await response.json() };
}

/** Walks the whole flow and returns the resulting tokens. */
export async function authorizeFully(
  baseUrl: string,
  password: string
): Promise<{ clientId: string; tokens: any }> {
  const { client_id: clientId } = await registerClient(baseUrl);
  const { verifier, challenge } = pkcePair();
  const { loginRequest } = await beginAuthorization(baseUrl, clientId, challenge);

  if (!loginRequest) {
    throw new Error('Authorization page did not render a login form');
  }

  const login = await submitLogin(baseUrl, loginRequest, password);
  const code = new URL(login.headers.get('location') ?? '').searchParams.get('code');

  if (!code) {
    throw new Error('Login did not produce an authorization code');
  }

  const { body: tokens } = await exchangeCode(baseUrl, clientId, code, verifier);
  return { clientId, tokens };
}

/** Posts a JSON-RPC message to /mcp, unwrapping an SSE response if there is one. */
export async function mcpRequest(
  baseUrl: string,
  accessToken: string | undefined,
  message: unknown
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  };

  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(message)
  });

  const text = await response.text();
  let body: any;

  try {
    body = text.startsWith('event:') ? JSON.parse(text.split('data: ')[1].split('\n')[0]) : JSON.parse(text);
  } catch {
    body = text;
  }

  return { status: response.status, body };
}
