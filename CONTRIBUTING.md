# Contributing

Thanks for helping! The most valuable contribution right now is **testing on other hardware**.

## Hardware reports

Open an issue with the "Hardware report" template: board, card model, BMC firmware version,
which tools worked, and anything odd. Reports on other AMI MegaRAC / ASPEED BMCs are welcome too.

## Development

```bash
npm install
ASUS_IPMI_HOST=… ASUS_IPMI_PASSWORD=… npm run smoke   # read-only + one screenshot
```

- Node.js ≥ 22.19, ES modules, no build step.
- Scripts in `test/` act on **real hardware**: read them before running.
- Never commit credentials, BMC addresses, or screenshots with private data.
- Keep protocol knowledge in comments next to the code (`src/kvm.js`, `src/firmware.js`, `src/media.js`).
- Don't add AMI's decoder (`decode_worker.js`) or any other vendor code to the repo.
