# Ratchet Stop

Chrome extension for **market entry, trailing stop-limits, and flatten** on [Vest Markets](https://next.vestmarkets.com).

**Proprietary software** — see [legal/LICENSE](./legal/LICENSE) and [EULA](./EULA.md). Do not redistribute source or release builds without permission.

## Quick start (development)

1. `chrome://extensions` → Developer mode → **Load unpacked** → this repo root (for your own work).
2. Open Vest, sign in, open a chart. Panel is bottom-left (`Alt+Shift+B`).
3. Sync, then Long/Short / trail / Close / Flatten.

## Ship to users (production)

1. `npm install`
2. `npm run build:release` → creates **`release/`** (obfuscated JS).
3. **Chrome Web Store**: zip `release/` only — never upload the source tree.
4. **GitHub releases** (recommended for users): [Latest release](https://github.com/jr23ae3/ratchet-stop/releases/latest) — download `ratchet-stop-v*-extension.zip`, unzip, **Load unpacked** → the unzipped folder. Source is public; ship the obfuscated zip, not a raw clone, when you want less readable JS.

See [docs/LICENSE_API.md](./docs/LICENSE_API.md) to turn on paid keys.

## Protection stack (what this repo includes)

| Layer | Purpose |
|-------|---------|
| [legal/LICENSE](./legal/LICENSE) / [EULA](./EULA.md) | Legal prohibition on copying & resale |
| `release/` obfuscation | `npm run build:release` — harder casual theft |
| `license/validator.js` | Optional server license check (`enforce: true`) |
| Popup license key | Users activate when enforcement is on |
| No secrets in repo | `.gitignore` blocks `.env`, `.crx`, `release/` |

**Note:** Browser extensions cannot be made uncopyable. This stack deters casual clones and supports licensed distribution.

### Enable license enforcement (later)

1. Deploy validate API (example in `docs/LICENSE_API.md`).
2. Edit `license/config.js`: `enabled: true`, `enforce: true`, `apiUrl: 'https://your-server/...'`.
3. Restore license UI in `popup.html` if you removed it (or ship a build that includes it).
3. Add your API host to `manifest.json` `host_permissions` if needed.
4. Rebuild release and publish.

Default `enabled: false` — no license UI or checks. Turn on later with `enabled: true` + `enforce: true` and an API URL.

## Support code

Checkout uses Vest code **`AEthatsMe`** (auto-applied on capital/checkout flows).

## Notes

- Uses your Vest login session.
- Trades the account selected in Vest.
- Default tick **0.25** on NQ/ES-style symbols.
