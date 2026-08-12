import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  // Get command line arguments
  const [toolName, date] = process.argv.slice(2);
  
  if (!toolName || !date) {
    console.error('Usage: node test.js <tool_name> <date>');
    process.exit(1);
  }

  const serverPath = join(__dirname, 'build/index.js');
  
  // Create MCP client
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      OURA_PERSONAL_ACCESS_TOKEN: process.env.OURA_PERSONAL_ACCESS_TOKEN,
    }
  });

  const client = new Client(
    {
      name: 'test-client',
      version: '1.0.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  try {
    console.log('Connecting to server...');
    await client.connect(transport);

    console.log('Listing resources...');
    const resources = await client.listResources();
    console.log('Available resources:', resources);

    console.log('\nListing tools...');
    const tools = await client.listTools();
    console.log('Available tools:', tools);

    // Test various resources
    const resourceTests = [
      'personal_info',
      'daily_activity',
      'daily_readiness',
      'ring_configuration'
    ];

    for (const resource of resourceTests) {
      console.log(`\nFetching ${resource}...`);
      const data = await client.readResource({
        uri: `oura://${resource}`
      });
      console.log(`${resource} data:`, data);
    }

    // Call the specified tool with the given date
    console.log(`\nCalling ${toolName}...`);
    const data = await client.callTool({
      name: toolName,
      arguments: {
        startDate: date,
        endDate: date,
      },
    });
    console.log(`${toolName} data:`, data);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    process.exit(0);
  }
}

main(); 