// MCP server: exposes screen, mouse, keyboard, power, sensors and virtual media of an
// ASUS IPMI Expansion Card (AMI MegaRAC BMC, ASPEED AST2600) as tools (defined in src/tools.js).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTools, flagsFromEnv, bmcFromEnv, VERSION } from './tools.js';

const env = process.env;
const log = (msg) => process.stderr.write(`[asus-ipmi-mcp] ${msg}\n`);

export const INSTRUCTIONS =
  'Controls a physical server through its ASUS IPMI card (remote screen, keyboard, mouse, power). ' +
  'Typical loop: screenshot -> decide -> click/type_text/press_keys (with expect_screen=<screen_id of that screenshot>, then_screenshot=true) -> decide. ' +
  'Always look right before typing: if the host locked its screen or shows a password prompt, typed commands end up there; expect_screen refuses input when the screen changed. ' +
  'Mouse coordinates are absolute screen pixels. Keyboard assumes a US layout on the host. ' +
  'A black screen usually means the host display is asleep; screenshot nudges the mouse to wake it. ' +
  'Only one controlling KVM session exists per card: using these tools takes control from an open browser viewer. ' +
  'A card restart (firmware dry run/flash, kvm_reset) ends a login session: the user must run "asus-ipmi-mcp login <host>" again.';

export async function main() {
  if (!env.ASUS_IPMI_HOST) {
    log('ASUS_IPMI_HOST must be set.');
    process.exit(1);
  }
  let bmc;
  try { bmc = bmcFromEnv(env.ASUS_IPMI_HOST); } catch (e) { log(e.message); process.exit(1); }
  const flags = flagsFromEnv();
  const { tools, close } = createTools({ bmc, flags, log });

  const server = new McpServer({ name: 'asus-ipmi-mcp', version: VERSION }, { instructions: INSTRUCTIONS });
  for (const t of tools) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) }, t.handler);
  }
  await server.connect(new StdioServerTransport());
  log(`v${VERSION} ready for ${env.ASUS_IPMI_HOST}, auth: ${bmc.tokenMode ? `session tokens (${bmc.sessionPath})` : 'password'} ` +
    `(power: ${flags.power ? 'on' : 'off'}, media write: ${flags.media ? 'on' : 'off'}, firmware flash: ${flags.firmware ? 'on' : 'off'}, bmc reset: ${flags.bmcReset ? 'on' : 'off'})`);
  const shutdown = async () => { await close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
}
