// Smoke test: start the server over stdio like an MCP client would, call read-only tools.
// Usage: node bin/asus-ipmi-mcp.js login <host>; then ASUS_IPMI_HOST=<host> node test/smoke.js [outdir]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = process.argv[2] || '/tmp';
const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(root, 'bin/asus-ipmi-mcp.js')],
  env: { ...process.env }, stderr: 'inherit',
});
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);
const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));
for (const name of ['system_info', 'sensors', 'kvm_status', 'media_status']) {
  const r = await client.callTool({ name, arguments: {} });
  console.log(`\n== ${name}${r.isError ? ' (ERROR)' : ''}\n`, r.content[0].text.slice(0, 700));
}
const s = await client.callTool({ name: 'screenshot', arguments: {} });
for (const c of s.content) {
  if (c.type === 'image') { const f = path.join(out, 'mcp-screenshot.' + (c.mimeType === 'image/png' ? 'png' : 'jpg')); fs.writeFileSync(f, Buffer.from(c.data, 'base64')); console.log('\n== screenshot ->', f); }
  else console.log(c.text);
}
await client.close();
