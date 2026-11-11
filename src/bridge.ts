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
  try {
    await client.connect(transport, { timeout: 10_000 });
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function bridge(connection: () => { port: number; token: string }) {
  let upstream: { port: number; token: string; client: Promise<Client> } | undefined;
  const release = () => {
    const previous = upstream;
    upstream = undefined;
    if (previous) void previous.client.then(client => client.close()).catch(() => {});
  };
  const client = () => {
    const { port, token } = connection();
    if (upstream?.port === port && upstream.token === token) return upstream.client;
    release();
    const next = connect(port, token).catch(error => {
      if (upstream?.client === next) upstream = undefined;
      throw error;
    });
    upstream = { port, token, client: next };
    return next;
  };
  const server = new Server({ name: 'hivemind-bridge', version }, { capabilities: { tools: {}, resources: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async request => (await client()).listTools(request.params));
  server.setRequestHandler(CallToolRequestSchema, async request => (await client()).callTool(request.params));
  server.setRequestHandler(ListResourcesRequestSchema, async request => (await client()).listResources(request.params));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async request => (await client()).listResourceTemplates(request.params));
  server.setRequestHandler(ReadResourceRequestSchema, async request => (await client()).readResource(request.params));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  server.onclose = release;
  process.stdin.once('end', () => { void server.close(); });
}
