# Security

This server gives an AI agent keyboard, mouse, screen and (opt-in) power and firmware control over
a physical machine. Treat its configuration like physical access to that machine.

- Keep `ASUS_IPMI_ALLOW_POWER`, `ASUS_IPMI_ALLOW_MEDIA` and `ASUS_IPMI_ALLOW_FIRMWARE` off unless needed.
- Use a dedicated BMC user and a strong password; keep the card on a management network.
- The card's self-signed TLS certificate is accepted without verification.
- Don't put credentials into prompts or screenshots you share.

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/tomas-polach/asus-ipmi-mcp/security/advisories/new)
instead of a public issue. Vulnerabilities in the IPMI card firmware itself should go to ASUS.
