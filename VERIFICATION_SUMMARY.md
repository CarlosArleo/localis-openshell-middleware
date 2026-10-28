# Localis OpenShell middleware: verification summary

Date: 28 October 2026

## Result

A tool call made from inside an OpenShell sandbox on a native Ubuntu VM (Google Cloud) was intercepted by this middleware and **denied, fail closed**, because no Localis gateway was reachable. The same behaviour was confirmed earlier by calling the middleware directly.

This shows the **deny path** end to end. It does not show an approved call or receipt generation: the call from the middleware to the real Localis/PhyOS gateway is still a placeholder (see "Not verified").

## Environment

| | |
|---|---|
| Passing run | Ubuntu VM on Google Cloud, OpenShell sandbox via Docker Engine |
| OpenShell version | 0.1.6 |
| Ubuntu version | 26.04.1 LTS |
| Earlier, failed run | Ubuntu 26.04.1 on WSL2 (kernel 6.18.54.1-microsoft-standard-WSL2), OpenShell 0.1.6 |

## Verified

1. **The middleware fails closed (direct test).** With no Localis gateway reachable, a gRPC `EvaluateHttpRequest` call carrying an MCP `tools/call` body returned `DECISION_DENY` with `reason_code: localis_unreachable`. A plain request (no `tools/call`) returned `DECISION_ALLOW`. Test: `npx tsx test-client.ts`. Before the fix, an unreachable gateway fell through to ALLOW, which contradicted `on_error: fail_closed` in `policy.yaml`.
2. **OpenShell accepts the middleware.** The gateway first refused it because `Describe` returned no protocol metadata. After adding the `extension` field (protocol 1.0, capability `openshell.supervisor-middleware.contract`), the gateway started with the middleware registered, and `openshell gateway info` lists `localis-gateway-middleware (supervisor-middleware)`, implementation `localis/gateway-middleware 1.0.0`.
3. **Sandbox run on a native VM.** The sandbox started, and the middleware's console logged:

   ```
   [OpenShell Intercepted] Target: httpbin.org/anything
   -> MCP Tool Call detected: test_tool
   -> Gateway unreachable: DENIED (fail closed).
   ```

   The sandbox `localis-test` was listed as `Ready` (28 October 2026). The response the agent received inside the sandbox:

   ```
   HTTP/1.1 403 Forbidden
   Content-Type: application/json
   Content-Length: 272
   X-OpenShell-Policy: test-http
   Connection: close

   {"error":"middleware_denied","detail":"Request rejected by configured middleware","policy":"test-http","middleware":"localis-guard","reason_code":"localis_unreachable","layer":"l7","method":"POST","path":"/anything","host":"httpbin.org","port":80,"binary":"/usr/bin/perl"}
   ```

   The denial is attributed to the middleware (`middleware: localis-guard`) and carries the middleware's own `reason_code: localis_unreachable`, which matches the console log above.

   Note: this request was made with `/usr/bin/perl` over HTTP on port 80, not with `curl` over HTTPS as in `CLOUD_DEPLOY.md`.

4. **Control case: a plain request is not blocked.** A request from the sandbox that was not an MCP tool call was sent to the same destination. The middleware's console logged only:

   ```
   [OpenShell Intercepted] Target: httpbin.org/anything
   ```

   There is no `MCP Tool Call detected` line, so the middleware took its default ALLOW path. The response the agent received for this request was not recorded.

## Not verified

- **An approved call through the real Localis/PhyOS gateway, and receipts.** The middleware forwards the body with a plain `POST` to `LOCALIS_GATEWAY_URL`. The real gateway needs mTLS, an MCP session and a signed `X-Phyora-Principal` header, none of which is implemented. No receipt is generated or exported.
- **The control case's sandbox-side response.** The middleware log shows the allow path, but the response the agent received (whether the request reached the destination) was not recorded.
- **The `curl` over HTTPS path** described in `CLOUD_DEPLOY.md` and allowed by `policy.yaml`'s `test-http` rule: the recorded denial came from a `perl` request over HTTP on port 80.
- **Error paths in code but not exercised by a test:** unparseable body (`localis_unparseable`) and gateway non-2xx (`localis_denied`).
- **Authentication between OpenShell and the middleware.** The test used insecure local transport (`allow_insecure_transport = true`).

## Environment finding: WSL2

On WSL2 the sandbox could not start. The supervisor's log shows `seccomp notification probe: Resource busy (os error 16)`. A direct test in that Ubuntu (installing a seccomp filter with a notification listener) also failed with errno 16, and PID 1 already carried a seccomp filter. So a listener was already in the filter chain and OpenShell's supervisor could not install its own. What installed that filter was not identified. The same sandbox started on the native VM.

## Differences from the original brief

- `openshell gateway start` does not exist in 0.1.6. The gateway is run as `openshell-gateway`, then registered with `openshell gateway add`.
- The middleware is registered in the gateway's TOML config (`[openshell]`, `version = 2`, `[[openshell.supervisor.middleware]]`), not in `policy.yaml`. The policy only names it.
- The middleware speaks gRPC (not HTTP) on port 50051 and must be running before the gateway starts, because the gateway calls `Describe` at startup.
- OpenShell supervisor middleware is documented as a research preview; its contract may change.

## Reproduce

See `CLOUD_DEPLOY.md`.
