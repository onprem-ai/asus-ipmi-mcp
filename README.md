# asus-ipmi-mcp

MCP server that lets an AI agent operate a physical machine through its **ASUS IPMI Expansion Card**:
see the screen, click, type, press keys, read sensors, control power, and mount ISO images — the same
things you'd do in the card's web KVM, but as tools. No browser, no Java, no VNC.

Use cases: unattended OS installs, BIOS changes, rescue on headless boxes, provisioning on-prem
servers from Claude Code / Cursor / any MCP client.

```
agent ──MCP(stdio)──> asus-ipmi-mcp ──HTTPS/WSS──> IPMI card (AST2600) ──USB HID + VGA──> host
```

## Supported hardware

| | |
|---|---|
| Tested | ASUS IPMI Expansion Card-SI (90MC0AH0-MVUBY1), BMC firmware **1.3.13**, on a ProArt X870E-CREATOR WIFI |
| Should work | Other ASUS boards from the [compatible model list](https://dlcdnets.asus.com/pub/ASUS/mb/Add-on_card/IPMI_EXPANSION_CARD/Compatible_Model_List.pdf); likely other AMI MegaRAC BMCs with ASPEED AST2500/2600 and the H5Viewer (untested) |

## Install

Requires Node.js ≥ 20 on the machine running the agent, and network access to the card's management port.

Run straight from GitHub (replace `<owner>`):

```bash
npx -y github:<owner>/asus-ipmi-mcp
```

### Claude Code

```bash
claude mcp add asus-ipmi \
  -e ASUS_IPMI_HOST=192.168.0.144 -e ASUS_IPMI_USER=admin -e ASUS_IPMI_PASSWORD='…' \
  -- npx -y github:<owner>/asus-ipmi-mcp
```

### Generic MCP config (Claude Desktop, Cursor, …)

```json
{
  "mcpServers": {
    "asus-ipmi": {
      "command": "npx",
      "args": ["-y", "github:<owner>/asus-ipmi-mcp"],
      "env": {
        "ASUS_IPMI_HOST": "192.168.0.144",
        "ASUS_IPMI_USER": "admin",
        "ASUS_IPMI_PASSWORD": "…",
        "ASUS_IPMI_ALLOW_POWER": "0",
        "ASUS_IPMI_ALLOW_MEDIA": "0"
      }
    }
  }
}
```

For several machines, add one entry per card with different names.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ASUS_IPMI_HOST` | – (required) | Card IP / hostname |
| `ASUS_IPMI_USER` | `admin` | Card user (needs KVM privilege) |
| `ASUS_IPMI_PASSWORD` | – (required) | Card password |
| `ASUS_IPMI_ALLOW_POWER` | off | `1` enables `power` and `set_boot_once` |
| `ASUS_IPMI_ALLOW_MEDIA` | off | `1` enables `media_configure_share`, `media_mount`, … |
| `ASUS_IPMI_SCREENSHOT_MAX` | `1024` | Long side of returned screenshots (pixels) |

## Tools

| Tool | What |
|---|---|
| `screenshot` | Current screen as an image (optional crop region for small text). Wakes a sleeping display. |
| `wait_for_screen_change` | Blocks until the screen changes (boot, install step), returns a screenshot |
| `click`, `move_mouse`, `drag`, `scroll` | Absolute mouse in screen pixels |
| `type_text` | Type text (US layout, `\n` = Enter) |
| `press_keys` | Keys / combos: `enter`, `f2`, `del`, `ctrl+alt+delete`, `ctrl+alt+f3`, `super`, with repeat |
| `kvm_status` | Resolution, display blank?, mouse mode, other KVM clients |
| `system_info` | BMC firmware, host power state, host BIOS/model |
| `sensors` | Temperatures, fans, voltages |
| `media_status` | Virtual-media settings and active redirections |
| `power` *(opt-in)* | `On`, `ForceOff`, `GracefulShutdown`, `ForceRestart` |
| `set_boot_once` *(opt-in)* | Next boot from `Cd`, `Pxe`, `Usb`, `Hdd`, `BiosSetup` |
| `media_configure_share`, `media_list_images`, `media_mount`, `media_unmount` *(opt-in)* | Attach an ISO from an NFS/CIFS share as virtual CD |

Typical agent loop: `screenshot` → decide → `click` / `type_text` / `press_keys` → `wait_for_screen_change`.

## How it works

- Logs in to the card's web API, gets a KVM token, opens `wss://<card>/kvm` and speaks AMI's IVTP
  protocol (the same as the card's HTML5 viewer).
- Video is ASPEED's compressed format. It is decoded with **AMI's own decoder**, which this package
  does **not** ship: on first use it is downloaded from *your* card
  (`/libs/kvm/ast/decode_worker.js`) and cached in `~/.cache/asus-ipmi-mcp/` (per card + firmware).
- Keyboard and mouse are sent as USB HID reports through the same connection; the card presents
  itself to the host as a USB keyboard and absolute mouse.
- Power, sensors and boot override use the card's Redfish API.

## Things to know

- **One controlling KVM session per card.** Using the tools takes control from an open browser
  viewer (the viewer gets a "Permission Requested" prompt and loses control after ~30 s).
- **Black screen / "no signal"** usually means the host display is asleep. `screenshot` nudges the
  mouse to wake it. For unattended work, disable screen blanking on the host.
- **No monitor needed** on the host: the card provides the display. A monitor attached to the board's
  own outputs may take the picture away from the card.
- **US keyboard layout** is assumed. On hosts with another layout, symbols and some letters differ.
- **Sensors empty / host BIOS unknown**: ASUS desktop/workstation boards need a special IPMI-enabled
  BIOS from ASUS support for full sensor integration. KVM, keyboard, mouse and power state work without it.
- **Power-button pass-through**: on a ProArt X870E without the special BIOS, wiring the chassis
  power/reset buttons through the card made the board hang at the DRAM Q-LED. Wire them directly to the board.
- The card's self-signed certificate is accepted (no TLS verification).

## Safety

This server can type passwords, power-cycle machines and boot installers. Keep `ASUS_IPMI_ALLOW_POWER`
and `ASUS_IPMI_ALLOW_MEDIA` off unless needed, use a dedicated card user, put the card on a management
network, and review what the agent does — it's physical access over the network.

## Development

```bash
npm install
ASUS_IPMI_HOST=… ASUS_IPMI_PASSWORD=… npm run smoke     # read-only tools + one screenshot
```

Protocol notes are in the source headers (`src/kvm.js`, `src/media.js`).

## License

MIT for this code. The video decoder is AMI property and is fetched from your own device at runtime.
