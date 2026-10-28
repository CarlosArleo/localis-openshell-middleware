# Localis OpenShell Middleware

A gRPC service that sits in front of an [OpenShell](https://github.com/NVIDIA/OpenShell) sandbox. OpenShell's supervisor sends it every outbound HTTP request the sandboxed agent makes, and it answers ALLOW or DENY. Its job is to stop MCP tool calls that the Localis gateway has not approved.

It implements the `openshell.middleware.v1.SupervisorMiddleware` service (`proto/supervisor_middleware.proto`) for the `HTTP_REQUEST` operation in the `PRE_CREDENTIALS` phase.

## What it does

| Request | Result | `reason_code` |
|---|---|---|
| Not a POST, or the body does not contain `tools/call` | ALLOW | none |
| MCP `tools/call`, body is not valid JSON | DENY | `localis_unparseable` |
| MCP `tools/call`, Localis gateway unreachable or no answer within 5 s | DENY | `localis_unreachable` |
| MCP `tools/call`, gateway answers with a non-2xx status | DENY | `localis_denied` |
| MCP `tools/call`, gateway answers 2xx | ALLOW | none |

The rule is fail closed: anything that looks like a tool call and cannot be positively approved is denied. This matches `on_error: fail_closed` in `policy.yaml`.

## Known limitations

- **The gateway call is a placeholder.** The middleware forwards the body with a plain `POST` to `LOCALIS_GATEWAY_URL`. The real Localis/PhyOS gateway needs mutual TLS, an MCP session (`initialize`, then `tools/call` with `Mcp-Session-Id`) and a signed `X-Phyora-Principal` header. Until that is implemented, a tool call is allowed only if something at that URL answers 2xx.
- **No authentication on the gRPC port.** It uses insecure transport. Never expose port 50051 beyond the machine that runs OpenShell. The service forwards request bodies to your gateway URL, so anyone who can reach it can make it send traffic there.
- **OpenShell's middleware interface is a research preview** (tested against OpenShell 0.1.6) and may change.
- `tsc` reports type errors from the project's existing `tsconfig.json`. `tsx` does not type-check, so they do not stop the server from running.

## Run it

Requires Node.js 18 or later.

```bash
npm install
LOCALIS_BIND=127.0.0.1:50051 npx tsx server.ts
```

PowerShell:

```powershell
$env:LOCALIS_BIND="127.0.0.1:50051"
npx tsx server.ts
```

It prints `Localis OpenShell Middleware running on port 50051`.

| Variable | Default | Meaning |
|---|---|---|
| `LOCALIS_BIND` | see `BIND` in `server.ts` | Address and port to listen on. Use `127.0.0.1:50051` unless OpenShell cannot reach it. |
| `LOCALIS_GATEWAY_URL` | `http://localhost:8443/mcp` | Localis gateway endpoint the tool call is forwarded to. |

## Test it without OpenShell

With the server running, in a second terminal:

```bash
npx tsx test-client.ts
```

`test-client.ts` loads the same `.proto` file and calls `EvaluateHttpRequest` twice. With no gateway at `LOCALIS_GATEWAY_URL`, expect:

- Tool call: `DECISION_DENY`, `reason_code: localis_unreachable`
- Plain request: `DECISION_ALLOW`

The server's console should show `-> MCP Tool Call detected: test_tool` and `-> Gateway unreachable: DENIED (fail closed).`

## Register it with OpenShell

The middleware is registered in the **gateway's TOML config**, not in `policy.yaml`. The policy only refers to it by name.

```toml
[openshell]
version = 2

[[openshell.supervisor.middleware]]
name = "localis-gateway-middleware"
grpc_endpoint = "http://127.0.0.1:50051"
allow_insecure_transport = true
max_payload_bytes = 4194304
timeout = "8s"
```

- `name` must equal the `middleware:` value in `policy.yaml`.
- `timeout` is longer than the middleware's own 5 s gateway timeout so the middleware can deny before OpenShell gives up.
- Start the middleware **before** the gateway. The gateway calls `Describe` at startup and refuses to start if the middleware is unreachable.
- `Describe` must return the `extension` protocol metadata (protocol 1.0, capability `openshell.supervisor-middleware.contract`). Without it the gateway rejects the registration.

Check the registration with `openshell gateway info`; `localis-gateway-middleware` should appear under Extensions.

## Files

| File | Purpose |
|---|---|
| `server.ts` | The gRPC service |
| `proto/supervisor_middleware.proto` | OpenShell's middleware contract (must match the installed OpenShell version) |
| `policy.yaml` | Sandbox policy: attaches the middleware to all endpoints with `fail_closed`, allows `curl` to `POST https://httpbin.org/anything` |
| `test-client.ts` | Calls the service directly to check ALLOW and DENY |
| `CLOUD_DEPLOY.md` | Steps to run the full sandbox test on a native Ubuntu VM |
| `VERIFICATION_SUMMARY.md` | What has and has not been verified |
