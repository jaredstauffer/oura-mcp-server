import { config as dotenvConfig } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOuraProvider } from './config.js';

// Resolve .env against the repo root rather than the caller's cwd: MCP clients
// spawn this server from an arbitrary working directory.
dotenvConfig({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });

async function main() {
  const provider = createOuraProvider();
  const transport = new StdioServerTransport();

  await provider.getServer().connect(transport);
}

main().catch(error => {
  console.error('Server error:', error);
  process.exit(1);
});
