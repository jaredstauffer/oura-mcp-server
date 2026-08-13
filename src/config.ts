import { OuraProvider } from './provider/oura_provider.js';

export const OURA_API_BASE_URL = 'https://api.ouraring.com/v2';

/**
 * Builds an Oura provider from the environment, shared by both entrypoints so
 * the stdio and HTTP servers can never disagree about how credentials load.
 */
export function createOuraProvider(): OuraProvider {
  const personalAccessToken = process.env.OURA_PERSONAL_ACCESS_TOKEN || '';
  const clientId = process.env.OURA_CLIENT_ID || '';
  const clientSecret = process.env.OURA_CLIENT_SECRET || '';

  if (!personalAccessToken && (!clientId || !clientSecret)) {
    throw new Error('Either OURA_PERSONAL_ACCESS_TOKEN or both OURA_CLIENT_ID and OURA_CLIENT_SECRET must be provided');
  }

  return new OuraProvider({
    personalAccessToken,
    clientId,
    clientSecret,
    redirectUri: process.env.OURA_REDIRECT_URI || 'http://localhost:3000/callback'
  });
}

export function requireEnv(name: string, hint: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} must be set. ${hint}`);
  }

  return value;
}
