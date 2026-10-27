#!/usr/bin/env node
// asus-ipmi-mcp                       run the MCP server (stdio)
// asus-ipmi-mcp login <host>          ask for the password once, store only session tokens
// asus-ipmi-mcp logout <host>         end the sessions on the card and delete the token file
// asus-ipmi-mcp call <host> <tool> …  call one tool without an MCP client (see src/cli.js)
// asus-ipmi-mcp run <host> steps.json run several tool calls in one session
// asus-ipmi-mcp tools                 list the tools
const [cmd, host, ...rest] = process.argv.slice(2);
const fatal = (e) => { process.stderr.write(`[asus-ipmi-mcp] ${e.message || e}\n`); process.exit(1); };

if (cmd === 'login' || cmd === 'logout') {
  const ui = rest.indexOf('--user');
  const user = ui >= 0 ? rest[ui + 1] : (process.env.ASUS_IPMI_USER || 'admin');
  const { login, logout } = await import('../src/session.js');
  (cmd === 'login' ? login({ host, user }) : logout({ host })).catch(fatal);
} else if (cmd === 'call' || cmd === 'run' || cmd === 'tools') {
  const { cli } = await import('../src/cli.js');
  // Exit explicitly: undici keep-alive sockets would otherwise hold the process open.
  cli(process.argv.slice(2)).then((code) => process.exit(code), fatal);
} else if (cmd === '-h' || cmd === '--help') {
  process.stdout.write(`usage:
  asus-ipmi-mcp                                    MCP server on stdio (ASUS_IPMI_HOST=<host>)
  asus-ipmi-mcp login <host> [--user <user>]       store session tokens (asks for the password once)
  asus-ipmi-mcp logout <host>                      end the sessions, delete the token file
  asus-ipmi-mcp tools                              list tools (honours ASUS_IPMI_ALLOW_*)
  asus-ipmi-mcp call <host> <tool> ['<json>'] [--out <file>]
  asus-ipmi-mcp run <host> <steps.json|-> [--out-dir <dir>] [--keep-going]
`);
} else {
  const { main } = await import('../src/server.js');
  main().catch((e) => {
    process.stderr.write(`[asus-ipmi-mcp] fatal: ${e.stack || e}\n`);
    process.exit(1);
  });
}
