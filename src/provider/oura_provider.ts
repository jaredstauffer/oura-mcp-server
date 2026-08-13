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
      startDate: z.string().describe('Start of the range, inclusive, as YYYY-MM-DD'),
      endDate: z.string().describe('End of the range, inclusive, as YYYY-MM-DD')
    };

    // Add resources and tools for each endpoint.
    //
    // The descriptions are the only thing a model has to choose between these,
    // and several pairs are easy to confuse - daily_sleep vs sleep, daily_stress
    // vs session - so each one says what the data actually is and, where the
    // distinction matters, points at its neighbour.
    const endpoints = [
      {
        name: 'personal_info',
        requiresDates: false,
        description: 'Profile details: age, weight, height, biological sex, and email.'
      },
      {
        name: 'daily_activity',
        requiresDates: true,
        description:
          'Daily activity score and its contributors, with active calories, MET minutes, ' +
          'equivalent walking distance, inactivity alerts, and time spent at each activity ' +
          'level. One record per day. Use for movement, steps, or calorie-burn questions.'
      },
      {
        name: 'daily_readiness',
        requiresDates: true,
        description:
          'Daily readiness score and its contributors, plus body temperature deviation and ' +
          'trend. One record per day. Use for "how recovered am I" or readiness questions.'
      },
      {
        name: 'daily_sleep',
        requiresDates: true,
        description:
          'Nightly sleep SCORE and its contributors, one record per day. Use for sleep ' +
          'quality questions ("how well did I sleep"). For stage durations, time asleep, ' +
          'or overnight heart rate, use sleep instead.'
      },
      {
        name: 'sleep',
        requiresDates: true,
        description:
          'Detailed record of each individual sleep period: bedtime start and end, deep, ' +
          'light, and REM durations, awake time, latency, efficiency, average heart rate, ' +
          'average HRV, and breathing rate. Use for sleep stages, how long someone slept, ' +
          'or overnight heart rate and HRV. For the nightly score, use daily_sleep instead.'
      },
      {
        name: 'sleep_time',
        requiresDates: true,
        description:
          'Oura\'s recommended optimal bedtime window, with a recommendation and status per ' +
          'day. This is advice about when to sleep, not a measurement of sleep that happened.'
      },
      {
        name: 'workout',
        requiresDates: true,
        description:
          'Logged workouts with activity type, intensity, calories, distance, start and end ' +
          'times, and how the workout was recorded. Use for exercise and training questions.'
      },
      {
        name: 'session',
        requiresDates: true,
        description:
          'Guided or logged sessions such as breathing exercises, meditation, relaxation, or ' +
          'naps, with type, duration, heart rate, HRV, mood, and motion count. These are ' +
          'discrete logged sessions, not the daily stress summary - see daily_stress for that.'
      },
      {
        name: 'daily_spo2',
        requiresDates: true,
        description:
          'Daily average blood oxygen saturation (SpO2) percentage and breathing disturbance ' +
          'index, one record per day.'
      },
      {
        name: 'rest_mode_period',
        requiresDates: true,
        description:
          'Periods when Rest Mode was switched on, with start and end days and the episodes ' +
          'within each period. Use for questions about illness or deliberate time off.'
      },
      {
        name: 'ring_configuration',
        requiresDates: false,
        description:
          'The ring itself: colour, design, size, hardware type, firmware version, and when ' +
          'it was set up.'
      },
      {
        name: 'daily_stress',
        requiresDates: true,
        description:
          'Daily stress summary: seconds spent in high stress and in recovery, plus an ' +
          'overall summary label for the day. One record per day.'
      },
      {
        name: 'daily_resilience',
        requiresDates: true,
        description:
          'Daily resilience level and its contributors - a longer-horizon measure of how well ' +
          'the body is handling stress, distinct from the day-to-day daily_stress figures.'
      },
      {
        name: 'daily_cardiovascular_age',
        requiresDates: true,
        description:
          'Estimated vascular age for each day, to compare against chronological age.'
      },
      {
        name: 'vO2_max',
        requiresDates: true,
        description:
          'Estimated VO2 max readings - cardiorespiratory fitness - with the day and ' +
          'timestamp of each estimate.'
      }
    ];

    // Add resources
    endpoints.forEach(({ name, requiresDates, description }) => {
      this.server.registerResource(
        name,
        `oura://${name}`,
        {
          description: requiresDates ? `${description} Covers the last 7 days.` : description,
          mimeType: 'application/json'
        },
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
    endpoints.filter(e => e.requiresDates).forEach(({ name, description }) => {
      this.server.registerTool(
        `get_${name}`,
        {
          description: `${description} Returns records over an inclusive date range.`,
          inputSchema: dateRangeSchema
        },
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