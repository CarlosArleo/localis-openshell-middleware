// Unit tests for classify.ts: tool calls are recognised on the parsed JSON-RPC method, so encodings of the same
// message cannot slip through, and bodies that cannot be inspected are unclassifiable (the server denies them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./classify";

const J = [{ name: "content-type", value: "application/json" }];
const b = (s: string) => Buffer.from(s, "utf8");

test("plain tool call", () => {
  assert.deepEqual(classify(J, b('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_money"}}')), { kind: "tool_call", tools: ["send_money"] });
});

test("escaped method names parse to tools/call and are caught (the 31 Oct bypass)", () => {
  assert.equal(classify(J, b('{"jsonrpc":"2.0","method":"tools\\/call","params":{"name":"x"}}')).kind, "tool_call");
  assert.equal(classify(J, b('{"jsonrpc":"2.0","method":"tools\\u002fcall","params":{"name":"x"}}')).kind, "tool_call");
  assert.equal(classify(J, b('{"jsonrpc":"2.0","method":"\\u0074ools/call","params":{"name":"x"}}')).kind, "tool_call");
});

test("batched JSON-RPC: any tool call in the array is caught", () => {
  assert.deepEqual(classify(J, b('[{"jsonrpc":"2.0","method":"ping"},{"jsonrpc":"2.0","method":"tools/call","params":{"name":"a"}}]')), { kind: "tool_call", tools: ["a"] });
});

test("whitespace, BOM and a missing or misleading content-type do not hide a tool call", () => {
  assert.equal(classify([], b('\uFEFF  \n {"method":"tools/call","params":{"name":"x"}}')).kind, "tool_call");
  assert.equal(classify([{ name: "content-type", value: "text/plain" }], b('{"method":"tools/call"}')).kind, "tool_call");
});

test("a tool call without a name is still a tool call", () => {
  assert.deepEqual(classify(J, b('{"method":"tools/call"}')), { kind: "tool_call", tools: ["<unnamed>"] });
});

test("unclassifiable: broken JSON, encoded bodies, invalid UTF-8 declared as JSON", () => {
  assert.equal(classify(J, b('{"method":"tools/call",')).kind, "unclassifiable");
  assert.equal(classify([{ name: "content-type", value: "text/plain" }], b("[1,2")).kind, "unclassifiable");
  assert.equal(classify([...J, { name: "content-encoding", value: "gzip" }], b("\x1f\x8b...")).kind, "unclassifiable");
  assert.equal(classify(J, Buffer.from([0x7b, 0xff, 0xfe, 0x7d])).kind, "unclassifiable");
});

test("not MCP: empty bodies, other JSON-RPC methods, non-JSON bodies", () => {
  assert.equal(classify(J, undefined).kind, "not_mcp");
  assert.equal(classify(J, Buffer.alloc(0)).kind, "not_mcp");
  assert.equal(classify(J, b('{"jsonrpc":"2.0","method":"tools/list"}')).kind, "not_mcp");
  assert.equal(classify([{ name: "content-type", value: "application/x-www-form-urlencoded" }], b("method=tools/call")).kind, "not_mcp");
  assert.equal(classify([], b('{"note":"tools/call in a string value is not a method"}')).kind, "not_mcp");
});
