/**
 * Stateless MCP (Model Context Protocol) JSON-RPC 2.0 handler.
 *
 * Self-contained copy of packages/sdk/src/mcp.js + the brand-info tool wiring
 * from packages/sdk/src/core.js. The template must not import from other
 * packages at runtime, so the protocol logic is duplicated here. When you
 * change the protocol surface in the SDK / production worker, change it here
 * too.
 *
 * Real MCP clients (Claude, MCP Inspector, ChatGPT connectors) speak JSON-RPC
 * over streamable HTTP: initialize → notifications/initialized → tools/list →
 * tools/call. This module implements the stateless subset - each POST is
 * handled independently with a single JSON response per request.
 */

export const MCP_PROTOCOL_VERSION = "2025-03-26";

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** Throw from callTool to report a tool-level failure in-band (isError: true). */
export class McpToolError extends Error {}

// Tool surface for the MCP server. The BYO-Worker tier exposes get_brand_info
// only (product tools need feed data this tier doesn't have) - keep in sync
// with the descriptor served by backend public_manifest.js and the SDK.
const MCP_TOOLS = [
  {
    name: "get_brand_info",
    description:
      "Get brand information including company overview, products, contact, and policies.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description:
            'Optional section filter: "about", "products", "contact", "policies", or omit for all.',
        },
      },
    },
  },
];

/**
 * Handle one MCP JSON-RPC message.
 *
 * @param {unknown} message  Parsed request body (or null on JSON parse failure).
 * @param {object} server
 * @param {string} server.name           serverInfo.name
 * @param {string} server.version        serverInfo.version
 * @param {Array}  server.tools          Tool descriptors.
 * @param {Function} server.callTool     async (name, args) → result object, or throws McpToolError.
 * @returns {{ status: number, body: object|null }}  body null → empty response (notifications).
 */
export async function handleMcpJsonRpc(message, server) {
  if (message === null || message === undefined) {
    return rpcError(null, PARSE_ERROR, "Parse error: body must be valid JSON");
  }
  // JSON-RPC batches were removed from MCP in the 2025-06-18 revision; we
  // never supported them, so reject explicitly.
  if (Array.isArray(message)) {
    return rpcError(null, INVALID_REQUEST, "Batch requests are not supported");
  }
  if (typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(message?.id ?? null, INVALID_REQUEST, "Invalid JSON-RPC 2.0 request");
  }

  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  // Notifications get 202 Accepted with no body (streamable HTTP transport).
  if (method.startsWith("notifications/")) {
    return { status: 202, body: null };
  }
  if (isNotification) {
    // Requests we'd have to answer but can't address - accept and drop.
    return { status: 202, body: null };
  }

  try {
    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: negotiateVersion(params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: { name: server.name, version: server.version },
        });

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, { tools: server.tools });

      case "tools/call": {
        const name = params?.name;
        if (!name || typeof name !== "string") {
          return rpcError(id, INVALID_PARAMS, "tools/call requires params.name");
        }
        if (!server.tools.some((t) => t.name === name)) {
          return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
        }
        const data = await server.callTool(name, params?.arguments || {});
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(data) }],
          isError: false,
        });
      }

      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err) {
    if (err instanceof McpToolError) {
      // Tool execution failures are reported in-band per the MCP spec so the
      // LLM can see them, not as protocol errors.
      return rpcResult(id, {
        content: [{ type: "text", text: err.message }],
        isError: true,
      });
    }
    return rpcError(id, INTERNAL_ERROR, "Internal error");
  }
}

/**
 * Handle an MCP request to /mcp or /.well-known/mcp.
 *
 * Speaks two protocols:
 *  - Standard MCP - JSON-RPC 2.0 over streamable HTTP (initialize, tools/list,
 *    tools/call). Detected by `jsonrpc: "2.0"` on the body (or a null body from
 *    a JSON parse failure, which becomes a JSON-RPC parse error).
 *  - Legacy Ooky protocol - { tool, arguments } → { result }.
 *
 * @param {unknown} body        Parsed request body, or null when JSON parsing failed.
 * @param {object}  opts
 * @param {string}  opts.domain        The brand domain (used for serverInfo.name).
 * @param {string}  opts.version       Template version string.
 * @param {Function} opts.getBrandInfo async (args) → manifest section. Throws McpToolError.
 * @returns {{ status: number, headers: object, body: object|null }}
 */
export async function handleMcpInvocation(body, opts) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "X-Ooky-Worker": "byo",
  };

  // Standard JSON-RPC 2.0 path (also handles null = unparseable body).
  if (body === null || body === undefined || body.jsonrpc === "2.0" || Array.isArray(body)) {
    const { status, body: rpcBody } = await handleMcpJsonRpc(body ?? null, {
      name: `ooky-${String(opts.domain).replace(/[^a-z0-9-]/gi, "-")}`,
      version: opts.version,
      tools: MCP_TOOLS,
      callTool: (name, args) => {
        if (name === "get_brand_info") return opts.getBrandInfo(args);
        throw new McpToolError(`Unknown tool: ${name}`);
      },
    });
    return { status, headers, body: rpcBody };
  }

  // Legacy { tool, arguments } path.
  if (typeof body !== "object") {
    return { status: 400, headers, body: { error: "JSON body required" } };
  }
  if (!body.tool) {
    return { status: 400, headers, body: { error: 'Missing "tool" field' } };
  }
  if (body.tool !== "get_brand_info") {
    return { status: 404, headers, body: { error: `Unknown tool: ${body.tool}` } };
  }
  try {
    const result = await opts.getBrandInfo(body.arguments);
    return { status: 200, headers, body: { result } };
  } catch (err) {
    return {
      status: 502,
      headers,
      body: { error: err instanceof McpToolError ? err.message : "Tool invocation failed" },
    };
  }
}

/**
 * Section filter for get_brand_info - mirrors the SDK/worker getBrandInfo
 * switch. When a section's keys are absent in the public manifest, fall back
 * to the full manifest rather than returning an empty object.
 */
export function filterBrandSection(manifest, section) {
  if (!section) return manifest;
  let picked;
  switch (section) {
    case "about":
      picked = { brand: manifest.brand, audience: manifest.audience };
      break;
    case "products":
      picked = {
        positioning: manifest.positioning,
        brand: manifest.brand && { name: manifest.brand.name },
      };
      break;
    case "contact":
      picked = {
        support: manifest.support,
        brand: manifest.brand && { name: manifest.brand.name, website: manifest.brand.website },
      };
      break;
    case "policies":
      picked = { aiGuidelines: manifest.aiGuidelines };
      break;
    default:
      return manifest;
  }
  const hasContent = Object.values(picked).some((v) => v != null);
  return hasContent ? picked : manifest;
}

/**
 * Echo the client's requested protocol version when we can speak it,
 * otherwise offer ours (the client disconnects if that's unacceptable).
 */
function negotiateVersion(requested) {
  if (typeof requested === "string" && requested <= MCP_PROTOCOL_VERSION) {
    return requested;
  }
  return MCP_PROTOCOL_VERSION;
}

function rpcResult(id, result) {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

function rpcError(id, code, message) {
  return { status: 200, body: { jsonrpc: "2.0", id, error: { code, message } } };
}
