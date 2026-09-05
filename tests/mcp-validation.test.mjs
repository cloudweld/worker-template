import { describe, expect, it, vi } from 'vitest';
import { handleMcpJsonRpc, MCP_PROTOCOL_VERSION } from '../src/mcp.js';
const server = { name: 'test', version: '1', tools: [{ name: 'get_brand_info' }], callTool: vi.fn(async () => ({})) };
describe('strict MCP envelope and version contract', () => {
  it.each(['0', '2024-01-01', '', 'not-a-version'])('never claims unsupported protocol %j', async (version) => {
    const response = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version } }, server);
    expect(response.body.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
  });
  it.each([null, true, {}, []])('rejects invalid request id %j', async (id) => {
    const response = await handleMcpJsonRpc({ jsonrpc: '2.0', id, method: 'ping' }, server);
    expect(response.body?.error?.code).toBe(-32600);
    expect(response.body.id).toBe(null);
  });
  it.each([null, [], 'bad', 1])('rejects malformed params %j', async (params) => {
    const response = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }, server);
    expect(response.body.error.code).toBe(-32602);
  });
  it.each([null, [], 'bad', 1])('rejects malformed tool arguments %j', async (args) => {
    const response = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_brand_info', arguments: args } }, server);
    expect(response.body.error.code).toBe(-32602);
  });
  it('does not silently swallow a notification method carrying a request id', async () => {
    const response = await handleMcpJsonRpc({ jsonrpc: '2.0', id: 1, method: 'notifications/initialized' }, server);
    expect(response.body.error.code).toBe(-32600);
  });
  it('preserves valid notification acknowledgement', async () => {
    expect(await handleMcpJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, server)).toEqual({ status: 202, body: null });
  });
});
