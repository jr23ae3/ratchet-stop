# LetsGetPaid

Chrome extension for **market entry, trailing stop-limits, and flatten** on [Vest Markets](https://next.vestmarkets.com).

**Proprietary software** — see [legal/LICENSE](./legal/LICENSE) and [EULA](./EULA.md). Do not redistribute source or release builds without permission.

## Quick start (public install)

See **[INSTALL.md](./INSTALL.md)** — clone this repo, **Load unpacked** on the repo root, use on Vest. No license key required with default settings.

## Quick start (development)

1. `chrome://extensions` → Developer mode → **Load unpacked** → this repo root.
2. Open Vest, sign in, open a chart. Panel is bottom-left (`Alt+Shift+B`).
3. Sync, then Long/Short / trail / Close / Flatten.

## Ship to users (production)

1. `npm install`
2. `npm run build:release` → creates **`release/`** (obfuscated JS).
3. **Chrome Web Store**: zip `release/` only — never upload the source tree.
4. Keep the Git repo **private** (GitHub private, or Cursor Origin without public clone).

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

### Enable license enforcement

1. Deploy validate API (example in `docs/LICENSE_API.md`).
2. Edit `license/config.js`: `enforce: true`, `apiUrl: 'https://your-server/...'`.
3. Add your API host to `manifest.json` `host_permissions` if needed.
4. Rebuild release and publish.

Default `enforce: false` keeps your current dev / friends install working without keys.

## Support code

Checkout uses Vest code **`AEthatsMe`** (auto-applied on capital/checkout flows).

## Notes

- Uses your Vest login session.
- Trades the account selected in Vest.
- Default tick **0.25** on NQ/ES-style symbols.
