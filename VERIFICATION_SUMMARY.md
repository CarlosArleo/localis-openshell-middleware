# Localis OpenShell middleware: verification summary

Date: 28 October 2026
Environment: Windows host; Ubuntu 26.04.1 on WSL2 (kernel 6.18.54.1-microsoft-standard-WSL2); OpenShell 0.1.6; Docker Engine inside Ubuntu.

## Verified

1. **The middleware fails closed.** With no Localis gateway reachable, a gRPC `EvaluateHttpRequest` call carrying an MCP `tools/call` body returned `DECISION_DENY` with `reason_code: localis_unreachable`. A plain request (no `tools/call`) returned `DECISION_ALLOW`. Test: `npx tsx test-client.ts`. Before the fix, an unreachable gateway fell through to ALLOW, which contradicted `on_error: fail_closed` in `policy.yaml`.
2. **OpenShell 0.1.6 accepts the middleware.** The gateway initially refused it because `Describe` returned no protocol metadata. After adding the `extension` field (protocol 1.0, capability `openshell.supervisor-middleware.contract`), the gateway started with the middleware registered, and `openshell gateway info` lists `localis-gateway-middleware (supervisor-middleware)`, implementation `localis/gateway-middleware 1.0.0`.
3. **Network path.** From a host-network container on Ubuntu's Docker, both the gateway (`127.0.0.1:17670`) and the middleware (`host.openshell.internal:50051`) were reachable.

## Not verified

- **The sandbox run.** `openshell sandbox create` failed before the supervisor started: `ControlSupervisorStartFailed: Docker sandbox exited before supervisor became ready`. The supervisor's own log shows `seccomp notification probe: Resource busy (os error 16)`.
- **Cause (partly established).** A direct test in this Ubuntu (installing a seccomp filter with a notification listener) also failed with errno 16, and PID 1 already carries one seccomp filter. So a listener is already in the filter chain and OpenShell's supervisor cannot install its own. What installed that filter is not identified. This is a limit of this WSL2 environment, not of the middleware or policy.
- **Interception end to end** (agent in sandbox, then OpenShell, then middleware).
- **The real Localis/PhyOS gateway call.** The middleware's call to the gateway is still a plain POST placeholder. The real gateway needs mTLS, an MCP session and a signed `X-Phyora-Principal` header. An ALLOW through a real gateway has not been demonstrated.
- **Error paths in code but not exercised by a test:** unparseable body (`localis_unparseable`) and gateway non-2xx (`localis_denied`).

## Differences from the original brief

- `openshell gateway start` does not exist in 0.1.6. The gateway is run as `openshell-gateway`, then registered with `openshell gateway add`.
- The middleware is registered in the gateway's TOML config (`[openshell]`, `version = 2`, `[[openshell.supervisor.middleware]]`), not in `policy.yaml`. The policy only names it.
- The middleware speaks gRPC (not HTTP) on port 50051 and must be running before the gateway starts, because the gateway calls `Describe` at startup.
- OpenShell supervisor middleware is documented as a research preview; its contract may change.

## Next step

Repeat the sandbox run on a native Ubuntu VM. See `CLOUD_DEPLOY.md`.
