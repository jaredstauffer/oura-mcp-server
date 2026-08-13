import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { STDIO_ENTRYPOINT, FAKE_OURA_TOKEN } from './helpers/server.js';


const DATED_ENDPOINTS = [
  'daily_activity',
  'daily_readiness',
  'daily_sleep',
  'sleep',
  'sleep_time',
  'workout',
  'session',
  'daily_spo2',
  'rest_mode_period',
  'daily_stress',
  'daily_resilience',
  'daily_cardiovascular_age',
  'vO2_max'
];

describe('stdio server surface', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO_ENTRYPOINT],
      env: { PATH: process.env.PATH ?? '', OURA_PERSONAL_ACCESS_TOKEN: FAKE_OURA_TOKEN }
    });

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
  });

  it('exposes a tool for every dated endpoint', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name).sort();

    expect(names).toEqual(DATED_ENDPOINTS.map(name => `get_${name}`).sort());
  });

  it('describes every tool', async () => {
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.description ?? '').not.toHaveLength(0);
    }
  });

  it('distinguishes the confusable sleep tools in their descriptions', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool.description ?? '']));

    // A model picks between these on description alone, so each must point at
    // the other rather than reading as an interchangeable pair.
    expect(byName['get_daily_sleep']).toContain('sleep instead');
    expect(byName['get_sleep']).toContain('daily_sleep instead');
  });

  it('documents the date parameters and the interval-sample opt-in', async () => {
    const { tools } = await client.listTools();
    const schema = tools.find(tool => tool.name === 'get_daily_sleep')?.inputSchema as any;

    expect(schema.required).toEqual(expect.arrayContaining(['startDate', 'endDate']));
    expect(schema.properties.startDate.description).toContain('YYYY-MM-DD');
    expect(schema.properties.includeIntervalSamples).toBeDefined();
    expect(schema.required).not.toContain('includeIntervalSamples');
  });

  it('exposes a resource for every endpoint, each described', async () => {
    const { resources } = await client.listResources();

    expect(resources).toHaveLength(DATED_ENDPOINTS.length + 2);
    for (const resource of resources) {
      expect(resource.description ?? '').not.toHaveLength(0);
    }
  });

  it('rejects a malformed date before it reaches Oura', async () => {
    const result: any = await client.callTool({
      name: 'get_daily_sleep',
      arguments: { startDate: 'last tuesday', endDate: '2026-08-01' }
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('YYYY-MM-DD');
  });
});

describe('stdio protocol hygiene', () => {
  /**
   * Regression test for diagnostics written to stdout. Under the stdio
   * transport stdout carries JSON-RPC, so a stray console.log corrupts the
   * stream - it did, on every tool call, until the logging moved to stderr.
   */
  it('writes nothing but JSON-RPC to stdout, even while logging a tool call', async () => {
    const child = spawn(process.execPath, [STDIO_ENTRYPOINT], {
      env: { PATH: process.env.PATH ?? '', OURA_PERSONAL_ACCESS_TOKEN: FAKE_OURA_TOKEN },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const messages = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c', version: '1' } }
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_daily_sleep', arguments: { startDate: '2026-08-01', endDate: '2026-08-01' } }
      }
    ];

    child.stdin.write(messages.map(message => JSON.stringify(message)).join('\n') + '\n');

    const stdout = await new Promise<string>(resolve => {
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += String(chunk);
      });
      setTimeout(() => {
        child.kill('SIGTERM');
        resolve(buffer);
      }, 6_000);
    });

    const lines = stdout.split('\n').filter(line => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
