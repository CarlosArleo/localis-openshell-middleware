import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';

const def = protoLoader.loadSync(path.join(__dirname, 'proto', 'supervisor_middleware.proto'), {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  includeDirs: [path.join(__dirname, 'proto')],
});
const pkg = grpc.loadPackageDefinition(def) as any;

// find the service that has EvaluateHttpRequest
const svcName = Object.keys(def).find(k => (def as any)[k] && (def as any)[k].EvaluateHttpRequest);
if (!svcName) throw new Error('No service with EvaluateHttpRequest found');
console.log('Service:', svcName);
const Ctor = svcName.split('.').reduce((o: any, k) => o[k], pkg);
const client = new Ctor('127.0.0.1:50051', grpc.credentials.createInsecure());

function call(label: string, method: string, body: string) {
  return new Promise<void>((resolve) => {
    client.EvaluateHttpRequest(
      { target: { host: 'httpbin.org', path: '/anything', method }, body: Buffer.from(body) },
      (err: any, res: any) => {
        console.log(`${label}:`, err ? 'ERROR ' + err.message : JSON.stringify(res));
        resolve();
      });
  });
}

(async () => {
  await call('Tool call (expect DENY)', 'POST', '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"test_tool"}}');
  await call('Plain request (expect ALLOW)', 'GET', '');
  process.exit(0);
})();
