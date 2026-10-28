# Running the OpenShell sandbox test on a native Ubuntu VM

Goal: show an agent in an OpenShell sandbox making an MCP tool call, OpenShell sending it to this middleware, and the middleware denying it (fail closed) because no Localis gateway approves it.

Why a VM: on WSL2 the sandbox supervisor failed with `seccomp notification probe: Resource busy (os error 16)`. See `VERIFICATION_SUMMARY.md`.

Everything below is written from the WSL session. Steps marked *untested* have not been run on a VM yet.

## Which terminal? (read this first)

Every command block below starts with a **Run in:** line. There are only two kinds of terminal.

| Name used below | What it is | How to recognise it |
|---|---|---|
| **PowerShell (your PC)** | A normal Windows PowerShell window on your own computer. Administrator is not needed. | Prompt starts with `PS C:\...>` |
| **VM window A, B or C** | Three separate PowerShell windows, each logged in to the VM with `ssh` (command in step 0). Once connected, they behave as Linux terminals. | Prompt looks like `ubuntu@vm-name:~$` |

What goes where:

- **VM window A** runs the middleware. Leave it open.
- **VM window B** runs the gateway. Leave it open.
- **VM window C** is for everything else (checks, installs, registering, the sandbox test).
- **PowerShell (your PC)** is used only to connect to the VM and copy the folder to it.

If your prompt starts with `PS C:\`, you are on your PC. If it shows `name@hostname:~$`, you are inside the VM. Linux commands (`ls`, `curl`, `sudo`, `openshell`, `docker`, `npm`) only work inside the VM. If you use GitHub Codespaces, ignore the `ssh` parts: open three terminals from its Terminal panel (the **+** button) and treat them as windows A, B and C.

## Two corrections to the plan

1. **The middleware's address does not go in `policy.yaml`.** The policy only names the middleware (`middleware: localis-gateway-middleware`). The address is `grpc_endpoint` in the **gateway's TOML config** (step 6). You do not need to edit `policy.yaml` for the VM.
2. **Do not bind to `0.0.0.0` first.** The port has no authentication. On WSL the Docker driver started the supervisor with host networking and it reached the gateway at `127.0.0.1:17670`, so on a native Linux VM the supervisor should reach `127.0.0.1:50051` too (*untested*). Try loopback first. The fallbacks are in step 5.

## 0. Pick the environment and connect

- **Recommended: a plain Ubuntu 24.04 x86_64 VM** (any cloud, or a Hyper-V/VirtualBox VM). Use a throwaway machine with no credentials on it: you will run installers from the internet.
- **GitHub Codespaces: risky.** A Codespace is itself a container, so it may inherit the same kind of seccomp filter that blocked WSL. Run the step 1 check first; it takes two minutes and tells you whether to continue.
- Use x86_64 (amd64). The OpenShell installer fetched an `amd64` package, and the check script below uses the x86_64 syscall number.

Firewall: allow inbound SSH only. Never open 50051 or 17670 to the internet or to your network. Everything in this test runs on the one machine.

Your cloud provider gives you the VM's public IP address, a username (often `ubuntu`) and an SSH key file.

**Run in:** PowerShell (your PC). Do this three times, in three separate PowerShell windows, to get VM windows A, B and C:

```powershell
ssh -i C:\path\to\your-key.pem ubuntu@VM_PUBLIC_IP
```

Replace the key path, username and IP with yours. If the provider uses a password instead of a key file, leave out `-i C:\path\to\your-key.pem`. The first time, answer `yes` to the fingerprint question.

## 1. Seccomp pre-flight check (before installing anything)

**Run in:** VM window C.

```bash
python3 - <<'EOF'
import ctypes, os, struct
libc = ctypes.CDLL(None, use_errno=True)
pid = os.fork()
if pid == 0:
    libc.prctl(38, 1, 0, 0, 0)
    prog = (ctypes.c_ubyte * 8)(*struct.pack("<HBBI", 0x06, 0, 0, 0x7fff0000))
    class F(ctypes.Structure):
        _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]
    f = F(1, ctypes.cast(prog, ctypes.c_void_p))
    r = libc.syscall(317, 1, 8, ctypes.byref(f))
    print("LISTENER OK, fd", r) if r >= 0 else print("FAILED errno", ctypes.get_errno())
    os._exit(0)
os.waitpid(pid, 0)
EOF
```

- `LISTENER OK`: continue.
- `FAILED errno 16`: this environment has the same problem as WSL. Stop and choose another machine.

## 2. Install Docker Engine

**Run in:** VM window C.

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
less get-docker.sh          # read it, press q to leave
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```

Then log out so the group change applies: type `exit` in window C, and reconnect with the `ssh` command from step 0 (**PowerShell (your PC)**). Windows A and B are not connected yet, so you can open them now.

**Run in:** VM window C (after reconnecting).

```bash
docker run --rm hello-world
```

Expect `Hello from Docker!`. Use Docker Engine from Docker's repository, not the snap package.

## 3. Install Node.js and copy the middleware to the VM

**Run in:** VM window C.

```bash
sudo apt-get update
sudo apt-get install -y nodejs npm
node --version              # needs v18 or later
```

Now copy the folder from your PC. Check first that the folder holds no keys or tokens. It must include `proto/`, `policy.yaml`, `server.ts`, `test-client.ts` and `package.json`.

**Run in:** PowerShell (your PC), a fourth window that is *not* logged in to the VM (the prompt must start with `PS C:\`).

```powershell
cd E:\Github\Aitiopoietic-Systems\localis-openshell-middleware
tar -czf $env:TEMP\localis-mw.tgz --exclude=node_modules .
scp -i C:\path\to\your-key.pem $env:TEMP\localis-mw.tgz ubuntu@VM_PUBLIC_IP:~/
```

Use the same key path, username and IP as in step 0.

**Run in:** VM window C.

```bash
mkdir -p ~/localis-openshell-middleware
tar -xzf ~/localis-mw.tgz -C ~/localis-openshell-middleware
cd ~/localis-openshell-middleware
npm install
```

Quick check, no OpenShell yet:

**Run in:** VM window C.

```bash
LOCALIS_BIND=127.0.0.1:50051 npx tsx server.ts &
sleep 3
npx tsx test-client.ts      # expect DENY for the tool call, ALLOW for the plain request
kill %1
```

## 4. Install OpenShell

**Run in:** VM window C.

```bash
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh -o install.sh
less install.sh             # read it; it verifies checksums. Press q to leave
sh install.sh && openshell --version
```

It asks for your sudo password if the VM requires one. Expect `openshell 0.1.6` or later. If it is a later version, the middleware contract may have changed (it is a research preview); compare `proto/supervisor_middleware.proto` with the one in the OpenShell repository for that version.

On a VM with systemd, the installer will probably start the `openshell-gateway` user service on port 17670 by itself (*untested*). Stop it so it does not clash with the run below.

**Run in:** VM window C.

```bash
systemctl --user stop openshell-gateway
systemctl --user disable openshell-gateway
```

## 5. Start the middleware

**Run in:** VM window A. Leave it running.

```bash
cd ~/localis-openshell-middleware
LOCALIS_BIND=127.0.0.1:50051 npx tsx server.ts
```

Expect `Localis OpenShell Middleware running on port 50051`.

If the supervisor cannot reach `127.0.0.1:50051` later (symptom in the troubleshooting table), use the fallbacks in this order:

1. Bind to the Docker bridge address only. **Run in:** VM window C: `ip -4 addr show docker0` (usually `172.17.0.1`). Then stop the middleware in window A with Ctrl+C and restart it there with `LOCALIS_BIND=172.17.0.1:50051 npx tsx server.ts`. Put the same address in `grpc_endpoint` in step 6, and restart the gateway.
2. Only if that fails: bind `0.0.0.0:50051`, **and** block the port from outside. **Run in:** VM window C: `sudo ufw deny 50051`, and make sure the cloud security group has no inbound rule for it. Check from another machine that the port is closed.

Never put the VM's public IP in `grpc_endpoint`.

## 6. Configure and start the gateway

**Run in:** VM window B. Leave it running at the end.

```bash
mkdir -p ~/.config/openshell
cat > ~/.config/openshell/gateway.toml <<'EOF'
[openshell]
version = 2

[[openshell.supervisor.middleware]]
name = "localis-gateway-middleware"
grpc_endpoint = "http://127.0.0.1:50051"
allow_insecure_transport = true
max_payload_bytes = 4194304
timeout = "8s"
EOF

export OPENSHELL_LOCAL_TLS_DIR=$HOME/.local/state/openshell/tls
export OPENSHELL_GATEWAY_CONFIG=$HOME/.config/openshell/gateway.toml
mkdir -p "$OPENSHELL_LOCAL_TLS_DIR" $HOME/.local/state/openshell/gateway
openshell-gateway config preflight
openshell-gateway generate-certs --output-dir "$OPENSHELL_LOCAL_TLS_DIR" --server-san host.openshell.internal
openshell-gateway
```

Expect two `WARN` lines (insecure transport, dynamic binding discovery) and then `Gateway listener bound address=127.0.0.1:17670`. No `Error:` line. The middleware in window A must already be running, because the gateway calls it at startup.

## 7. Register and check

**Run in:** VM window C.

```bash
openshell gateway add https://127.0.0.1:17670 --local --name openshell
openshell gateway info
```

`localis-gateway-middleware (supervisor-middleware)` must appear under Extensions.

## 8. Create the sandbox and run the test

**Run in:** VM window C.

```bash
openshell sandbox create --name localis-test --policy ~/localis-openshell-middleware/policy.yaml
```

The first run pulls a sandbox image, so allow a few minutes. When it is Ready, still in **VM window C**:

```bash
openshell sandbox exec --help     # confirm the syntax in this version
openshell sandbox exec localis-test -- curl -s -i -X POST https://httpbin.org/anything \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"test_tool"}}'
```

**Pass:**

- **VM window A** (the middleware) shows `[OpenShell Intercepted] Target: httpbin.org/anything`, then `-> MCP Tool Call detected: test_tool`, then `-> Gateway unreachable: DENIED (fail closed).`
- The sandbox command in window C does not return httpbin's normal echo. It should return a blocked response; the exact status is not known yet, so record what you see.

**Control test** (a request that is not a tool call should get through).

**Run in:** VM window C.

```bash
openshell sandbox exec localis-test -- curl -s -X POST https://httpbin.org/anything \
  -H 'Content-Type: application/json' -d '{"hello":"world"}'
```

Expect httpbin's echo, and `[OpenShell Intercepted]` in window A without a tool-call line.

Save the three outputs (window A's log, the deny result, the control result) as evidence.

## Troubleshooting

| Symptom | Likely cause and action |
|---|---|
| `preflight` says `missing_version` | `gateway.toml` lacks `[openshell]` and `version = 2` |
| Gateway fails at startup mentioning the middleware | The middleware is not running in window A, or `grpc_endpoint` is wrong. Start the middleware first |
| `did not provide protocol metadata` | `server.ts` `Describe` lacks the `extension` block (see the README) |
| `address already in use` on 17670 | The systemd gateway service is still running (step 4) |
| `ControlSupervisorStartFailed` | In window C run `openshell logs localis-test`. If it mentions seccomp, repeat step 1. Otherwise read the log |
| Supervisor starts but the call is not intercepted, and window A is silent | The supervisor cannot reach the middleware. Use the fallbacks in step 5 |
| Tool call returns httpbin's normal response | Something answers 2xx at `LOCALIS_GATEWAY_URL` (default `http://localhost:8443/mcp`). Stop it, or in window A restart the middleware with `LOCALIS_GATEWAY_URL=http://127.0.0.1:9` set before `npx tsx server.ts` |
| Everything is denied, including the control test | The policy's `fail_closed` is working but the middleware is unreachable. Check window A and window B's gateway log |
| `scp` or `ssh` says `Permission denied` | Wrong key path, username or IP. Use the values your cloud provider shows for the VM |

## Clean up

**Run in:** VM window C.

```bash
openshell sandbox delete localis-test
```

Stop the processes in windows A and B with Ctrl+C. Then delete the VM in your cloud provider's web console, and remove any copied files you no longer need from your PC (`$env:TEMP\localis-mw.tgz`).

## Still not covered by this test

The real PhyOS gateway call (mTLS, MCP session, signed principal header) is not implemented in `server.ts`, so this test shows the deny path only. An ALLOW through a real gateway needs that work first.
