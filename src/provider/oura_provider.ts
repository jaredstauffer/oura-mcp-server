import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OuraAuth } from './oura_connection.js';

export interface OuraConfig {
  personalAccessToken?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
}

export class OuraProvider {
  private server: McpServer;
  private auth: OuraAuth;

  constructor(config: OuraConfig) {
    this.auth = new OuraAuth(
      config.personalAccessToken,
      config.clientId,
      config.clientSecret,
      config.redirectUri
    );

    this.server = new McpServer({
      name: "oura-provider",
      version: "1.0.0"
    });

    this.initializeResources();
  }

  private async fetchOuraData(endpoint: string, params?: Record<string, string>): Promise<any> {
    const headers = await this.auth.getHeaders();
    const url = new URL(`${this.auth.getBaseUrl()}/usercollection/${endpoint}`);
    
    if (params) {
      // Diagnostics must go to stderr: under the stdio transport, stdout is the
      // JSON-RPC channel and anything else written there corrupts the stream.
      console.error(`Fetching ${endpoint} with dates:`, params);

      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.append(key, value);
      });
    }

    const response = await fetch(url.toString(), { headers });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${endpoint}: ${response.statusText}`);
    }

    const data = await response.json();
    // Log the response data dates
    if (data.data && data.data.length > 0) {
      console.error(`Response data for ${endpoint}:`, data.data.map((d: { day?: string; timestamp?: string }) => d.day || d.timestamp));
    }
    return data;
  }

  private initializeResources(): void {
    // Define the date range schema for tools
    const dateRangeSchema = {
      startDate: z.string(),
      endDate: z.string()
    };

    // Add resources and tools for each endpoint
    const endpoints = [
      { name: 'personal_info', requiresDates: false },
      { name: 'daily_activity', requiresDates: true },
      { name: 'daily_readiness', requiresDates: true },
      { name: 'daily_sleep', requiresDates: true },
      { name: 'sleep', requiresDates: true },
      { name: 'sleep_time', requiresDates: true },
      { name: 'workout', requiresDates: true },
      { name: 'session', requiresDates: true },
      { name: 'daily_spo2', requiresDates: true },
      { name: 'rest_mode_period', requiresDates: true },
      { name: 'ring_configuration', requiresDates: false },
      { name: 'daily_stress', requiresDates: true },
      { name: 'daily_resilience', requiresDates: true },
      { name: 'daily_cardiovascular_age', requiresDates: true },
      { name: 'vO2_max', requiresDates: true }
    ];

    // Add resources
    endpoints.forEach(({ name, requiresDates }) => {
      this.server.resource(
        name,
        `oura://${name}`,
        async (uri) => {
          let data;
          if (requiresDates) {
            // For date-based resources, fetch last 7 days by default
            const endDate = new Date().toISOString().split('T')[0];
            const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            data = await this.fetchOuraData(name, { start_date: startDate, end_date: endDate });
          } else {
            data = await this.fetchOuraData(name);
          }

          return {
            contents: [{
              uri: uri.href,
              text: JSON.stringify(data, null, 2)
            }]
          };
        }
      );
    });

    // Add tools
    endpoints.filter(e => e.requiresDates).forEach(({ name }) => {
      this.server.tool(
        `get_${name}`,
        dateRangeSchema,
        async ({ startDate, endDate }) => {
          const data = await this.fetchOuraData(name, {
            start_date: startDate,
            end_date: endDate
          });

          return {
            content: [{
              type: "text",
              text: JSON.stringify(data, null, 2)
            }]
          };
        }
      );
    });
  }

  getServer(): McpServer {
    return this.server;
  }
} 