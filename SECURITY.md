# Security

This server gives an AI agent keyboard, mouse, screen, power and firmware control over
a physical machine. Treat its configuration like physical access to that machine.

- **Don't put the card password in the MCP config.** Run `asus-ipmi-mcp login <card address>` once
  in a terminal: it asks for the password at a hidden prompt and stores only session tokens
  (mode 600; the server refuses a token file others can read). Leave `ASUS_IPMI_PASSWORD` unset.
  `asus-ipmi-mcp logout <card address>` ends the sessions on the card.
- Access control is the card session: whoever holds the token file (mode 600) can use every tool.
  Run `logout` when done.
- Use a dedicated BMC user and a strong password; keep the card on a management network.
- The card's self-signed TLS certificate is accepted without verification.
- Don't put credentials into prompts or screenshots you share.

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/onprem-ai/asus-ipmi-mcp/security/advisories/new)
instead of a public issue. Vulnerabilities in the IPMI card firmware itself should go to ASUS.
