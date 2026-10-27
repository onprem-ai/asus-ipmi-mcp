// Firmware tools through MCP: check, then prepare with dry_run (upload+verify+cancel, no flash).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const t = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'bin/asus-ipmi-mcp.js')], env: { ...process.env }, stderr: 'inherit' });
const c = new Client({ name: 'fw', version: '0' });
await c.connect(t);
console.log('tools:', (await c.listTools()).tools.map((x) => x.name).filter((n) => n.startsWith('firmware')).join(', '));
const show = (r) => console.log(r.isError ? 'ERROR' : 'ok', r.content[0].text.slice(0, 2500));
show(await c.callTool({ name: 'firmware_check_update', arguments: {} }));
show(await c.callTool({ name: 'firmware_prepare', arguments: { source: process.argv[2] || '1.3.13', dry_run: true } }, undefined, { timeout: 900000 }));
await c.close();
