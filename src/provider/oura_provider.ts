import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OuraAuth } from './oura_connection.js';

export interface OuraConfig {
  personalAccessToken: string;
  /** IANA zone used to work out what "the last 7 days" means. Defaults to UTC. */
  timezone?: string;
}

/** Stop following next_token eventually, so a pathological range can't loop forever. */
const MAX_PAGES = 25;

/**
 * Per-endpoint fields holding interval samples - one value every 30 seconds or
 * 5 minutes. A month of `sleep` with these included runs to megabytes, which
 * crowds out the conversation it was meant to inform, so they are dropped
 * unless explicitly asked for.
 */
const INTERVAL_SAMPLE_FIELDS: Record<string, string[]> = {
  sleep: ['heart_rate', 'hrv', 'movement_30_sec', 'sleep_phase_5_min'],
  daily_activity: ['class_5_min', 'met']
};

export class OuraProvider {
  private server: McpServer;
  private auth: OuraAuth;
  private timezone: string;

  constructor(config: OuraConfig) {
    this.auth = new OuraAuth(config.personalAccessToken);
    this.timezone = config.timezone || 'UTC';

    this.server = new McpServer({
      name: "oura-provider",
      version: "1.0.0"
    });

    this.initializeResources();
  }

  /** Today's date in the configured zone, as YYYY-MM-DD. */
  private localDate(offsetMs = 0): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date(Date.now() + offsetMs));
  }

  private async describeFailure(endpoint: string, response: Response): Promise<Error> {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      // Body already consumed or unreadable; the status is enough.
    }

    switch (response.status) {
      case 401:
        return new Error(
          `Oura rejected the credentials while fetching ${endpoint} (401). The ` +
            'OURA_PERSONAL_ACCESS_TOKEN is missing, expired, or revoked - issue a new one at ' +
            'https://cloud.ouraring.com/personal-access-tokens.'
        );
      case 403:
        return new Error(
          `Oura refused access to ${endpoint} (403). The token is valid but not permitted to ` +
            'read this data, which usually means the endpoint needs a scope the token lacks.'
        );
      case 429: {
        const retryAfter = response.headers.get('retry-after');
        return new Error(
          `Oura rate limit hit while fetching ${endpoint} (429).` +
            (retryAfter ? ` Retry after ${retryAfter}s.` : ' Try again shortly, or narrow the date range.')
        );
      }
      case 400:
        return new Error(
          `Oura rejected the request for ${endpoint} (400). Check that the dates are valid ` +
            `YYYY-MM-DD values and that the start is not after the end. ${detail}`
        );
      default:
        return new Error(
          `Failed to fetch ${endpoint}: ${response.status} ${response.statusText}. ${detail}`.trim()
        );
    }
  }

  private stripIntervalSamples(endpoint: string, records: unknown[]): unknown[] {
    const verbose = INTERVAL_SAMPLE_FIELDS[endpoint];
    if (!verbose) {
      return records;
    }

    return records.map(record => {
      if (!record || typeof record !== 'object') {
        return record;
      }

      const trimmed: Record<string, unknown> = { ...(record as Record<string, unknown>) };
      for (const field of verbose) {
        delete trimmed[field];
      }
      return trimmed;
    });
  }

  /**
   * Fetches an endpoint, following Oura's next_token pagination to completion.
   *
   * Without this, any range wider than a single page came back silently
   * truncated - the caller got a short `data` array with no indication that
   * more existed, and summarised it as though it were the whole story.
   */
  private async fetchOuraData(
    endpoint: string,
    params?: Record<string, string>,
    options: { includeIntervalSamples?: boolean } = {}
  ): Promise<any> {
    const headers = await this.auth.getHeaders();

    if (params) {
      // Diagnostics must go to stderr: under the stdio transport, stdout is the
      // JSON-RPC channel and anything else written there corrupts the stream.
      console.error(`Fetching ${endpoint} with dates:`, params);
    }

    const collected: unknown[] = [];
    let nextToken: string | undefined;
    let pages = 0;
    let singleDocument: any;

    do {
      const url = new URL(`${this.auth.getBaseUrl()}/usercollection/${endpoint}`);

      if (params) {
        Object.entries(params).forEach(([key, value]) => {
          url.searchParams.append(key, value);
        });
      }
      if (nextToken) {
        url.searchParams.set('next_token', nextToken);
      }

      const response = await fetch(url.toString(), { headers });

      if (!response.ok) {
        throw await this.describeFailure(endpoint, response);
      }

      const body = await response.json();

      // Single-document endpoints (personal_info) have no `data` array.
      if (!Array.isArray(body?.data)) {
        singleDocument = body;
        break;
      }

      collected.push(...body.data);
      nextToken = body.next_token ?? undefined;
      pages += 1;
    } while (nextToken && pages < MAX_PAGES);

    if (singleDocument !== undefined) {
      return singleDocument;
    }

    const records = options.includeIntervalSamples
      ? collected
      : this.stripIntervalSamples(endpoint, collected);

    console.error(`Fetched ${records.length} ${endpoint} record(s) across ${pages} page(s)`);

    return {
      data: records,
      ...(nextToken
        ? {
            truncated: true,
            note: `Stopped after ${MAX_PAGES} pages. Narrow the date range to see the rest.`
          }
        : {})
    };
  }

  private initializeResources(): void {
    // Define the date range schema for tools. The regex catches a malformed date
    // here rather than letting Oura reject it as an opaque 400.
    const isoDate = z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be formatted as YYYY-MM-DD');

    const dateRangeSchema = {
      startDate: isoDate.describe('Start of the range, inclusive, as YYYY-MM-DD'),
      endDate: isoDate.describe('End of the range, inclusive, as YYYY-MM-DD'),
      includeIntervalSamples: z
        .boolean()
        .optional()
        .describe(
          'Include high-volume interval samples (per-30-second and per-5-minute arrays such as ' +
            'heart_rate, hrv, and class_5_min). Omitted by default because they are very large. ' +
            'Only set this true for a short range where the detail is genuinely needed.'
        )
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
            // Last 7 days, bounded by the configured zone rather than UTC - near
            // midnight those disagree, and the window would be off by a day.
            data = await this.fetchOuraData(name, {
              start_date: this.localDate(-7 * 24 * 60 * 60 * 1000),
              end_date: this.localDate()
            });
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
        async ({ startDate, endDate, includeIntervalSamples }) => {
          const data = await this.fetchOuraData(
            name,
            { start_date: startDate, end_date: endDate },
            { includeIntervalSamples }
          );

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