// Integration test: starts the real server.ts (gRPC, loopback, ephemeral port) and calls EvaluateHttpRequest as
// OpenShell would. The "Localis gateway" is a local fake that is unreachable, rejecting (403) or accepting (200), so
// every decision path is asserted, including the 31 Oct escaped-method bypass.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

let gwStatus = 0; // 0 = unreachable (server closed), otherwise the status the fake gateway returns
let gateway: http.Server;
let gatewayUrl = "";
let child: ChildProcess;
let client: any;

async function startGateway(): Promise<void> {
  gateway = http.createServer((req, res) => { req.resume(); req.on("end", () => res.writeHead(gwStatus).end()); });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", () => r()));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/mcp`;
}

before(async () => {
  await startGateway();
  child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: __dirname, env: { ...process.env, LOCALIS_BIND: "127.0.0.1:0", LOCALIS_GATEWAY_URL: gatewayUrl }, stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`server did not start: ${out}`)), 20000);
    child.stdout!.on("data", (d) => { out += d; const m = /running on port (\d+)/.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
    child.on("exit", (code) => reject(new Error(`server exited ${code}: ${out}`)));
  });
  const def = protoLoader.loadSync(path.join(__dirname, "proto", "supervisor_middleware.proto"), { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [path.join(__dirname, "proto")] });
  const pkg = grpc.loadPackageDefinition(def) as any;
  client = new pkg.openshell.middleware.v1.SupervisorMiddleware(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
});

after(async () => { client?.close(); child?.kill(); await new Promise((r) => gateway.close(r)); });

function evaluate(body: string, method = "POST", headers = [{ name: "content-type", value: "application/json" }]): Promise<{ decision: string; reason_code: string }> {
  return new Promise((resolve, reject) => client.EvaluateHttpRequest(
    { target: { host: "httpbin.org", path: "/anything", method }, headers, body: Buffer.from(body) },
    (err: Error | null, res: any) => (err ? reject(err) : resolve({ decision: res.decision, reason_code: res.reason_code }))));
}

const TOOL = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_money"}}';
const ESCAPED = '{"jsonrpc":"2.0","method":"tools\\/call","params":{"name":"send_money"}}';

test("gateway unreachable: a tool call is denied (fail closed)", async () => {
  gwStatus = 0; await new Promise((r) => gateway.close(r));
  try {
    assert.deepEqual(await evaluate(TOOL), { decision: "DECISION_DENY", reason_code: "localis_unreachable" });
    assert.deepEqual(await evaluate(ESCAPED), { decision: "DECISION_DENY", reason_code: "localis_unreachable" }, "escaped method must not bypass");
    assert.deepEqual(await evaluate(`[{"method":"ping"},${TOOL}]`), { decision: "DECISION_DENY", reason_code: "localis_unreachable" }, "batched call");
  } finally {
    await new Promise<void>((r) => gateway.listen(Number(new URL(gatewayUrl).port), "127.0.0.1", () => r()));
  }
});

test("gateway rejects (403): denied with localis_denied", async () => {
  gwStatus = 403;
  assert.deepEqual(await evaluate(ESCAPED), { decision: "DECISION_DENY", reason_code: "localis_denied" });
});

test("gateway accepts (200): allowed (placeholder forward, no receipt)", async () => {
  gwStatus = 200;
  assert.equal((await evaluate(TOOL)).decision, "DECISION_ALLOW");
});

test("unclassifiable bodies are denied regardless of the gateway", async () => {
  gwStatus = 200;
  assert.deepEqual(await evaluate('{"method":"tools/call",'), { decision: "DECISION_DENY", reason_code: "localis_unclassifiable" });
  assert.deepEqual(await evaluate("\x1f\x8b", "POST", [{ name: "content-encoding", value: "gzip" }]), { decision: "DECISION_DENY", reason_code: "localis_unclassifiable" });
});

test("non-MCP traffic is left to OpenShell policy (allowed by the middleware)", async () => {
  gwStatus = 0;
  assert.equal((await evaluate("", "GET", [])).decision, "DECISION_ALLOW");
  assert.equal((await evaluate('{"jsonrpc":"2.0","method":"tools/list"}')).decision, "DECISION_ALLOW");
});
