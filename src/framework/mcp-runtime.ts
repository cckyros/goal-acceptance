// Hand-rolled MCP stdio server (JSON-RPC 2.0, newline-delimited), zero deps.
// Tools come from the manifest; stdout carries ONLY protocol messages,
// everything else goes to stderr. Same shape as deepseek-vl-support's server
// (verified against Codex / Copilot / Claude Code MCP clients).
import { createInterface } from "node:readline";
import { resolveConfig } from "./config.ts";
import type { PluginManifest } from "./manifest.ts";

export const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function errorResponse(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function resultResponse(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function toolResult(id: unknown, text: string, isError = false): void {
  resultResponse(id, {
    content: [{ type: "text", text }],
    isError,
  });
}

async function handleRequest(manifest: PluginManifest, req: JsonRpcRequest): Promise<void> {
  const id = req.id;
  const method = req.method;

  if (method === "initialize") {
    const clientVersion = (req.params?.protocolVersion as string) ?? PROTOCOL_VERSION;
    resultResponse(id, {
      protocolVersion:
        typeof clientVersion === "string" && clientVersion ? clientVersion : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: manifest.name, version: manifest.version },
    });
    return;
  }
  if (method === "notifications/initialized") return; // no response
  if (method === "ping") {
    resultResponse(id, {});
    return;
  }
  if (method === "tools/list") {
    resultResponse(id, {
      tools: manifest.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
    return;
  }
  if (method === "tools/call") {
    const name = req.params?.name;
    const args = (req.params?.arguments as Record<string, unknown> | undefined) ?? {};
    const tool = manifest.tools.find((t) => t.name === name);
    if (!tool) {
      errorResponse(id, -32602, `unknown tool: ${String(name)}`);
      return;
    }
    try {
      const ctx = {
        config: resolveConfigFor(manifest),
        log: (msg: string) => process.stderr.write(`[${manifest.name}] ${msg}\n`),
      };
      const result = await tool.handler(args, ctx);
      toolResult(id, JSON.stringify(result, null, 2));
    } catch (e) {
      toolResult(id, `error: ${e instanceof Error ? e.message : e}`, true);
    }
    return;
  }

  errorResponse(id, -32601, `method not found: ${String(method)}`);
}

function resolveConfigFor(
  manifest: PluginManifest,
): Record<string, string | number | boolean | undefined> {
  return resolveConfig(manifest, process.cwd()).values;
}

/** Run the stdio MCP server until stdin closes. */
export async function runMcpServer(manifest: PluginManifest): Promise<void> {
  process.stdin.setEncoding("utf8");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    if (typeof req.method !== "string") {
      send({ jsonrpc: "2.0", id: req.id ?? null, error: { code: -32600, message: "invalid request" } });
      continue;
    }
    try {
      await handleRequest(manifest, req);
    } catch (e) {
      if (req.id !== undefined) {
        errorResponse(req.id, -32603, `internal error: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}
