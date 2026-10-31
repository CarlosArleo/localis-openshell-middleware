// Classifies an HTTP request body intercepted by OpenShell: is it an MCP tool call?
//
// Decisions are made on the PARSED JSON-RPC message, never on substrings of the raw body: JSON escapes such as
// "tools\/call" or "tools/call" parse to exactly "tools/call" and must be caught. Batched JSON-RPC arrays are
// inspected element by element. Anything that looks like JSON but cannot be parsed, or that is content-encoded so it
// cannot be inspected, is "unclassifiable" and the server denies it (fail closed). Bodies that are clearly not JSON
// are "not_mcp" and left to OpenShell's own network policy.

export interface Header { name: string; value: string }

export type Classification =
  | { kind: "tool_call"; tools: string[] }
  | { kind: "not_mcp" }
  | { kind: "unclassifiable"; why: string };

const decoder = new TextDecoder("utf-8", { fatal: true });

function header(headers: readonly Header[], name: string): string | undefined {
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h?.value;
}

export function classify(headers: readonly Header[], body: Uint8Array | undefined): Classification {
  if (!body || body.length === 0) return { kind: "not_mcp" };

  const encoding = header(headers, "content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity") return { kind: "unclassifiable", why: `content-encoding ${encoding}` };

  const contentType = header(headers, "content-type")?.toLowerCase() ?? "";
  const declaredJson = contentType.includes("json");

  let text: string;
  try {
    text = decoder.decode(body);
  } catch {
    return declaredJson ? { kind: "unclassifiable", why: "invalid utf-8 in a json body" } : { kind: "not_mcp" };
  }
  const trimmed = text.replace(/^﻿/, "").trim();
  const looksJson = declaredJson || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!looksJson) return { kind: "not_mcp" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "unclassifiable", why: "json body does not parse" };
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const tools: string[] = [];
  for (const m of messages) {
    if (m && typeof m === "object" && !Array.isArray(m) && (m as Record<string, unknown>)["method"] === "tools/call") {
      const params = (m as Record<string, unknown>)["params"];
      const name = params && typeof params === "object" ? (params as Record<string, unknown>)["name"] : undefined;
      tools.push(typeof name === "string" ? name : "<unnamed>");
    }
  }
  return tools.length > 0 ? { kind: "tool_call", tools } : { kind: "not_mcp" };
}
