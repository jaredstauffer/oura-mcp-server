import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Minimal signed-token helpers.
 *
 * Everything this server hands out - client ids, authorization codes, access
 * and refresh tokens - is a signed payload rather than a row in a store. That
 * keeps the deployment stateless: a restart (or a second instance) can still
 * validate tokens it never issued, so a redeploy doesn't silently sign you out.
 */

export interface SignedClaims {
  /** Unique id, used to make authorization codes single-use. */
  jti: string;
  /** Expiry, seconds since epoch. Absent means the token does not expire. */
  exp?: number;
}

function hmac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function sign(claims: Record<string, unknown>, secret: string, ttlSeconds?: number): string {
  const payload: Record<string, unknown> = {
    ...claims,
    jti: randomBytes(9).toString('base64url')
  };

  if (ttlSeconds !== undefined) {
    payload.exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  }

  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmac(body, secret)}`;
}

export function verify<T>(token: string, secret: string): (T & SignedClaims) | undefined {
  const separator = token.lastIndexOf('.');
  if (separator <= 0) {
    return undefined;
  }

  const body = token.slice(0, separator);
  const provided = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(hmac(body, secret));

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return undefined;
  }

  let claims: T & SignedClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }

  if (typeof claims.exp === 'number' && claims.exp < Date.now() / 1000) {
    return undefined;
  }

  return claims;
}
