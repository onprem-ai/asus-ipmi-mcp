# Changelog

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
