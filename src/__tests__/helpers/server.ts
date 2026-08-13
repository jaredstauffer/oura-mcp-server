import { spawn, ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const HTTP_ENTRYPOINT = resolve(repoRoot, 'build', 'http.js');
export const STDIO_ENTRYPOINT = resolve(repoRoot, 'build', 'index.js');

/** A token that is well-formed but useless: enough to boot, never used against Oura. */
export const FAKE_OURA_TOKEN = 'test-token-not-a-real-credential';
export const TEST_PASSWORD = 'test-password-not-a-real-secret';

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const address = probe.address();
      if (typeof address === 'string' || address === null) {
        probe.close(() => reject(new Error('Could not determine a free port')));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

export interface RunningServer {
  baseUrl: string;
  stop: () => void;
}

/**
 * Boots the built HTTP entrypoint on a free port and waits for it to listen.
 *
 * The tests drive the real server over real HTTP rather than importing the
 * express app, because the behaviour under test - OAuth discovery, redirects,
 * bearer rejection - only exists at the transport boundary.
 */
export async function startHttpServer(env: Record<string, string> = {}): Promise<RunningServer> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const child: ChildProcess = spawn(process.execPath, [HTTP_ENTRYPOINT], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      PUBLIC_URL: baseUrl,
      OAUTH_SIGNING_SECRET: 'test-signing-secret-not-a-real-secret',
      MCP_AUTH_PASSWORD: TEST_PASSWORD,
      OURA_PERSONAL_ACCESS_TOKEN: FAKE_OURA_TOKEN,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const stop = () => {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  };

  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => {
      stop();
      fail(new Error('Server did not start within 15s'));
    }, 15_000);

    child.stderr?.on('data', chunk => {
      if (String(chunk).includes('listening on port')) {
        clearTimeout(timer);
        ready();
      }
    });

    child.on('exit', code => {
      clearTimeout(timer);
      fail(new Error(`Server exited early with code ${code}`));
    });
  });

  return { baseUrl, stop };
}
