import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';

// Load the OpenShell protobuf definitions
const PROTO_PATH = path.join(__dirname, 'proto', 'supervisor_middleware.proto');
const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
  includeDirs: [path.join(__dirname, 'proto')]
});

const openshellProto = grpc.loadPackageDefinition(packageDefinition) as any;

// Define the gRPC service implementation
const middlewareImplementation = {
  // 1. Describe: Tell OpenShell who we are and what phases we handle
  Describe: (call: any, callback: any) => {
    callback(null, {
      name: "localis-gateway-middleware",
      service_version: "1.0.0",
      expected_audience: "",
      extension: {
        protocol_version: { major: 1, minor: 0 },
        implementation_name: "localis/gateway-middleware",
        implementation_version: "1.0.0",
        supported_capabilities: ["openshell.supervisor-middleware.contract"],
        required_capabilities: ["openshell.supervisor-middleware.contract"]
      },
      bindings: [
        {
          operation: "SUPERVISOR_MIDDLEWARE_OPERATION_HTTP_REQUEST",
          phase: "SUPERVISOR_MIDDLEWARE_PHASE_PRE_CREDENTIALS",
          max_payload_bytes: 4194304 // 4MB, required for MCP
        }
      ]
    });
  },

  // 2. ValidateConfig: OpenShell asks if our policy config is valid
  ValidateConfig: (call: any, callback: any) => {
    callback(null, { valid: true, reason: "" });
  },

  // 3. EvaluateHttpRequest: The core logic
  EvaluateHttpRequest: async (call: any, callback: any) => {
    const req = call.request;
    
    // OpenShell passes the raw body as a Uint8Array. Convert to string.
    const bodyStr = req.body ? Buffer.from(req.body).toString('utf8') : "";
    
    console.log(`\n[OpenShell Intercepted] Target: ${req.target.host}${req.target.path}`);
    
    const deny = (reason: string, reason_code: string) => callback(null, { decision: "DECISION_DENY", reason, reason_code });

    // Check if this is an MCP tool call (JSON-RPC). Anything that looks like a tool call is decided fail-closed:
    // an unparseable body, an unreachable gateway or any error is a DENY, never an ALLOW.
    if (req.target.method === "POST" && bodyStr.includes("tools/call")) {
      let toolName: unknown;
      try {
        toolName = JSON.parse(bodyStr).params?.name;
      } catch {
        console.log(`-> Unparseable tool call: DENIED (fail closed).`);
        return deny("Tool call body could not be parsed", "localis_unparseable");
      }
      console.log(`-> MCP Tool Call detected: ${toolName}`);

      // Forward the exact MCP payload to the Localis gateway. NOTE: the real gateway listens with mutual TLS and needs
      // an MCP session (initialize, then tools/call with Mcp-Session-Id and a signed X-Phyora-Principal header); this
      // plain POST is only a placeholder for the interception test.
      let gatewayResponse: Response;
      try {
        gatewayResponse = await fetch(process.env.LOCALIS_GATEWAY_URL ?? "http://localhost:8443/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: bodyStr,
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        console.log(`-> Gateway unreachable: DENIED (fail closed).`);
        return deny("Localis gateway unreachable", "localis_unreachable");
      }
      if (!gatewayResponse.ok) {
        console.log(`-> Gateway DENIED the call.`);
        return deny("Localis gateway rejected the policy", "localis_denied");
      }
      console.log(`-> Gateway ALLOWED the call and issued a receipt.`);
    }

    // Default: Allow the request to proceed through OpenShell
    callback(null, {
      decision: "DECISION_ALLOW",
      reason: "Passed Localis gateway check"
    });
  }
};

// Start the gRPC server on port 50051
const server = new grpc.Server();
server.addService(openshellProto.openshell.middleware.v1.SupervisorMiddleware.service, middlewareImplementation);
// WSL 2 must reach this server on the Windows host, so it binds 0.0.0.0 by default. This is an unauthenticated
// (insecure) gRPC port: restrict it with a Windows Firewall rule to the WSL subnet, or set LOCALIS_BIND to the
// "vEthernet (WSL)" adapter address (e.g. LOCALIS_BIND=172.x.y.1:50051).
const BIND = process.env.LOCALIS_BIND ?? '0.0.0.0:50051';
server.bindAsync(BIND, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    console.error(err);
    return;
  }
  console.log(`Localis OpenShell Middleware running on port ${port}`);
});