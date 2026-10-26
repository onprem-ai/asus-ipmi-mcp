#!/usr/bin/env node
// asus-ipmi-mcp                 run the MCP server (stdio)
// asus-ipmi-mcp login <host>    ask for the password once, store only session tokens
// asus-ipmi-mcp logout <host>   end the sessions on the card and delete the token file
const [cmd, host, ...rest] = process.argv.slice(2);
const fatal = (e) => { process.stderr.write(`[asus-ipmi-mcp] ${e.message || e}\n`); process.exit(1); };

if (cmd === 'login' || cmd === 'logout') {
  const ui = rest.indexOf('--user');
  const user = ui >= 0 ? rest[ui + 1] : (process.env.ASUS_IPMI_USER || 'admin');
  const { login, logout } = await import('../src/session.js');
  (cmd === 'login' ? login({ host, user }) : logout({ host })).catch(fatal);
} else if (cmd === '-h' || cmd === '--help') {
  process.stdout.write('usage: asus-ipmi-mcp [login <host> [--user <user>] | logout <host>]\n');
} else {
  const { main } = await import('../src/server.js');
  main().catch((e) => {
    process.stderr.write(`[asus-ipmi-mcp] fatal: ${e.stack || e}\n`);
    process.exit(1);
  });
}
