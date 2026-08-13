import { Request, Response } from 'express';
import { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidRequestError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sign, verify } from './signing.js';
import { renderLoginPage } from './login_page.js';

const ACCESS_TOKEN_TTL = 60 * 60;
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60;
const AUTHORIZATION_CODE_TTL = 2 * 60;
const LOGIN_REQUEST_TTL = 10 * 60;

interface ClientClaims {
  client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>;
}

interface LoginRequestClaims {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  state?: string;
  resource?: string;
}

interface TokenClaims {
  typ: 'access' | 'refresh';
  clientId: string;
  scopes: string[];
  resource?: string;
}

/**
 * Client registry with no storage behind it: the signed client metadata *is*
 * the client id. Dynamic registration therefore survives restarts, which
 * matters because a connector that re-registers on every deploy would drop
 * its authorization each time.
 */
export class StatelessClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly secret: string) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const claims = verify<ClientClaims>(clientId, this.secret);
    if (!claims) {
      return undefined;
    }
    return { ...claims.client, client_id: clientId };
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>
  ): Promise<OAuthClientInformationFull> {
    // Register everyone as a public client authenticating with PKCE. The client
    // id is signed but *not* encrypted, so a client_secret carried inside it
    // would be readable by anyone holding the id - which is no secret at all.
    const { client_secret, client_secret_expires_at, ...publicClient } = client;
    const registered = { ...publicClient, token_endpoint_auth_method: 'none' };

    return {
      ...registered,
      client_id: sign({ client: registered }, this.secret),
      client_id_issued_at: Math.floor(Date.now() / 1000)
    };
  }
}

/**
 * An OAuth 2.1 authorization server for a single human being.
 *
 * The Oura credentials live in server-side env and are never exchanged with
 * the client; this flow exists purely to prove that whoever is talking to the
 * MCP endpoint is the person who knows MCP_AUTH_PASSWORD.
 */
export class SingleUserOAuthProvider implements OAuthServerProvider {
  private readonly _clientsStore: StatelessClientsStore;
  private readonly consumedCodes = new Map<string, number>();

  constructor(
    private readonly secret: string,
    private readonly password: string,
    private readonly scopes: string[]
  ) {
    this._clientsStore = new StatelessClientsStore(secret);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return this._clientsStore;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const loginRequest = sign(
      {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scopes: params.scopes ?? this.scopes,
        state: params.state,
        resource: params.resource?.href
      },
      this.secret,
      LOGIN_REQUEST_TTL
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderLoginPage({ loginRequest, clientName: client.client_name }));
  }

  /**
   * Handles the password form posted by the page `authorize` rendered. On
   * success this is what actually completes the OAuth redirect.
   */
  handleLogin = async (req: Request, res: Response): Promise<void> => {
    const { login_request: loginRequest, password } = req.body ?? {};

    if (typeof loginRequest !== 'string' || typeof password !== 'string') {
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderLoginPage({ error: 'Malformed sign-in request. Start the connection again from Claude.' }));
      return;
    }

    const request = verify<LoginRequestClaims>(loginRequest, this.secret);
    if (!request) {
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderLoginPage({ error: 'This sign-in request expired. Start the connection again from Claude.' }));
      return;
    }

    if (!this.passwordMatches(password)) {
      res.status(401).setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderLoginPage({ loginRequest, error: 'Incorrect password.' }));
      return;
    }

    const code = sign(
      {
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        scopes: request.scopes,
        resource: request.resource
      },
      this.secret,
      AUTHORIZATION_CODE_TTL
    );

    const redirect = new URL(request.redirectUri);
    redirect.searchParams.set('code', code);
    if (request.state !== undefined) {
      redirect.searchParams.set('state', request.state);
    }

    res.redirect(302, redirect.toString());
  };

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    return this.decodeAuthorizationCode(client, authorizationCode).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const code = this.decodeAuthorizationCode(client, authorizationCode);

    if (redirectUri !== undefined && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }

    this.consumeAuthorizationCode(code.jti, code.exp);

    return this.issueTokens(client.client_id, code.scopes, resource?.href ?? code.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const claims = verify<TokenClaims>(refreshToken, this.secret);

    if (!claims || claims.typ !== 'refresh' || claims.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }

    // Narrowing is allowed on refresh; widening is not.
    const granted = scopes?.length ? scopes.filter(scope => claims.scopes.includes(scope)) : claims.scopes;

    return this.issueTokens(client.client_id, granted, resource?.href ?? claims.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = verify<TokenClaims>(token, this.secret);

    if (!claims || claims.typ !== 'access') {
      throw new InvalidTokenError('Invalid or expired access token');
    }

    return {
      token,
      clientId: claims.clientId,
      scopes: claims.scopes,
      expiresAt: claims.exp,
      resource: claims.resource ? new URL(claims.resource) : undefined
    };
  }

  private issueTokens(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    return {
      access_token: sign({ typ: 'access', clientId, scopes, resource }, this.secret, ACCESS_TOKEN_TTL),
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: sign({ typ: 'refresh', clientId, scopes, resource }, this.secret, REFRESH_TOKEN_TTL),
      scope: scopes.join(' ')
    };
  }

  private decodeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): LoginRequestClaims & { jti: string; exp?: number } {
    const code = verify<LoginRequestClaims>(authorizationCode, this.secret);

    if (!code || code.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }

    if (this.consumedCodes.has(code.jti)) {
      throw new InvalidGrantError('Authorization code has already been used');
    }

    return code;
  }

  /**
   * Codes are single-use. They're signed rather than stored, so the only way to
   * enforce that is to remember the ones already redeemed - but only until they
   * would have expired anyway, which bounds the map without a sweeper.
   */
  private consumeAuthorizationCode(jti: string, exp?: number): void {
    const now = Math.floor(Date.now() / 1000);

    for (const [seen, expiresAt] of this.consumedCodes) {
      if (expiresAt <= now) {
        this.consumedCodes.delete(seen);
      }
    }

    this.consumedCodes.set(jti, exp ?? now + AUTHORIZATION_CODE_TTL);
  }

  private passwordMatches(candidate: string): boolean {
    // Hash both sides so the comparison is constant-time regardless of length.
    const provided = createHash('sha256').update(candidate).digest();
    const expected = createHash('sha256').update(this.password).digest();
    return timingSafeEqual(provided, expected);
  }
}

export { InvalidRequestError };
