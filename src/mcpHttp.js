/**
 * Per-connection MCP server exposed over HTTP (Streamable HTTP, stateless).
 * External MCP clients connect to  <base>/mcp/<connectionId>  with
 * Authorization: Bearer <connection apiKey>. Tools are the connection's saved
 * tools plus a universal `run_instruction` for anything not yet saved.
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const connections = require('./connectionStore');
const siteAgent = require('./siteAgent');

function buildServer(conn) {
  const server = new Server(
    { name: `42mcp-${conn.domain}`, version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: `MCP server for the authenticated website ${conn.domain}. ` +
        `Use the saved tools, or run_instruction with a natural-language task. ` +
        `Login-only automation of the account owner's own session; write actions require their approval.`
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const saved = (conn.tools || []).map((t) => ({
      name: t.name,
      description: t.description || t.title || `Run "${t.name}" on ${conn.domain}`,
      inputSchema: t.inputSchema || { type: 'object', properties: {} }
    }));
    saved.push({
      name: 'run_instruction',
      description: `Carry out any natural-language instruction on the authenticated ${conn.domain} session and return structured JSON.`,
      inputSchema: {
        type: 'object',
        properties: { instruction: { type: 'string', description: 'What to do or fetch.' } },
        required: ['instruction']
      }
    });
    return { tools: saved };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const fresh = connections.get(conn.id) || conn;
    let instruction = args.instruction;
    if (name !== 'run_instruction') {
      const tool = (fresh.tools || []).find((t) => t.name === name);
      if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
      instruction = args.instruction || tool.description;
    }
    if (!instruction) return { isError: true, content: [{ type: 'text', text: 'An instruction is required.' }] };
    try {
      const out = await siteAgent.runInstruction(fresh, instruction);
      const structured = (out.result && typeof out.result === 'object') ? out.result : { text: out.result };
      return {
        content: [{ type: 'text', text: typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2) }],
        structuredContent: structured,
        isError: !out.ok
      };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `Tool failed: ${e.message}` }] };
    }
  });

  return server;
}

/**
 * Express handler for  /mcp/:id  (POST for calls, GET/DELETE for the
 * stateless transport lifecycle). Validates the bearer key against the conn.
 */
async function handleMcpRequest(req, res) {
  const conn = connections.get(req.params.id);
  if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!auth || auth !== conn.apiKey) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid API key' }, id: null });
    return;
  }
  const server = buildServer(conn);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id: null });
  }
}

module.exports = { handleMcpRequest };
