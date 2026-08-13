import { config as dotenvConfig } from 'dotenv';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOuraProvider } from './config.js';

dotenvConfig();

async function main() {
  const provider = createOuraProvider();
  const transport = new StdioServerTransport();

  await provider.getServer().connect(transport);
}

main().catch(error => {
  console.error('Server error:', error);
  process.exit(1);
});
