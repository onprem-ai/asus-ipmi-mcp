#!/usr/bin/env node
import { main } from '../src/server.js';

main().catch((e) => {
  process.stderr.write(`[asus-ipmi-mcp] fatal: ${e.stack || e}\n`);
  process.exit(1);
});
