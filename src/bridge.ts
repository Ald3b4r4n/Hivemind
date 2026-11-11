import { version } from './version.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export async function connect(port: number, token: string) {
  const client = new Client({ name: 'hivemind-client', version });
  const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + '/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer ' + token, Connection: 'close' } },
  });
  await client.connect(transport, { timeout: 10_000 });
  return client;
}

export async function bridge(port: number, token: string) {
  const client = await connect(port, token);
  const server = new Server({ name: 'hivemind-bridge', version }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler(ListToolsRequestSchema, request => client.listTools(request.params));
  server.setRequestHandler(CallToolRequestSchema, request => client.callTool(request.params));
  server.setRequestHandler(ListResourcesRequestSchema, request => client.listResources(request.params));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, request => client.listResourceTemplates(request.params));
  server.setRequestHandler(ReadResourceRequestSchema, request => client.readResource(request.params));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.once('end', () => { void client.close(); void server.close(); });
}
