const OURA_API_BASE_URL = 'https://api.ouraring.com/v2';

/**
 * Authentication against the Oura API.
 *
 * Personal access tokens only. An earlier version of this class also accepted
 * OAuth2 client credentials, but nothing ever ran the authorization-code flow
 * to turn them into an access token, so that path could only ever fail at
 * request time with "Not authenticated". Better to reject it up front.
 */
export class OuraAuth {
  private readonly accessToken: string;

  constructor(personalAccessToken: string) {
    if (!personalAccessToken) {
      throw new Error('A personal access token is required');
    }

    this.accessToken = personalAccessToken;
  }

  async getHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json'
    };
  }

  getBaseUrl(): string {
    return OURA_API_BASE_URL;
  }
}
