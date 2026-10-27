# Changelog

## 0.2.0 – unreleased

Fixes and features from a fleet session (four cards, firmware 1.1.35 → 1.3.13).

- **Fix: card restarts in token mode were misreported.** A firmware dry run said "back after 20 s"
  while the session was already dead, and a flash said "did not come back" although the card was up.
  Restarts are now followed with an unauthenticated `GET /redfish/v1` (down, then up). In token
  mode the result is `bmc_up: true` plus a hint to run `login` again.
- A running server re-reads the token file, so a new `login` takes effect without a restart.
- **Clear error when the card still has its default password** (instead of "session expired").
  `login` checks both sessions and stores nothing when the card refuses access.
- **KVM errors give the cause right away** instead of "not validated within 15 s": the viewer holds
  control or denied it, the card closed the connection, or the card's KVM service is stuck.
  The "RSV1 must be clear" error turned out to be the card's web server writing a plain HTTP reply
  into the websocket (`H` = `0x48` parses as RSV1 + opcode 8), so it is not about compression. The
  error now says to restart the card. WebSocket compression is no longer offered.
- `kvm_status` reports who holds control and the last connect error, even when connecting fails.
- New opt-in tool `kvm_reset` (`ASUS_IPMI_ALLOW_BMC_RESET`): restarts the card and waits for it.
- `type_text` / `press_keys`: `then_screenshot` returns the settled screen; `expect_screen`
  (a `screen_id` from `screenshot`) refuses input if the screen changed meanwhile.
- Command line without an MCP client: `call`, `run` (many steps in one session, `$prev` references),
  `tools`.
- Firmware versions normalised (`1.01.35` = `1.1.35`); `system_info` shows both forms.
- The "no credentials" error names the token file it looked for.
- Unit tests against a fake card: `npm test`.

## 0.1.0 – unreleased

First public version.

- KVM over the card's WebSocket (AMI IVTP), video decoded with the decoder fetched from the card
- Tools: `screenshot`, `wait_for_screen_change`, `click`, `move_mouse`, `drag`, `scroll`,
  `type_text`, `press_keys`, `kvm_status`, `system_info`, `sensors`, `media_status`,
  `firmware_check_update`
- Opt-in tools: `power`, `set_boot_once` (`ASUS_IPMI_ALLOW_POWER`), virtual media
  (`ASUS_IPMI_ALLOW_MEDIA`), `firmware_prepare` / `firmware_flash` (`ASUS_IPMI_ALLOW_FIRMWARE`)
- `login` / `logout` commands: password asked once at a hidden prompt, only session tokens
  stored (mode 600); the server runs on them without `ASUS_IPMI_PASSWORD`
- Tested on ASUS IPMI Expansion Card-SI, BMC firmware 1.3.13, ProArt X870E-CREATOR WIFI
