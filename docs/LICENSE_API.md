# License validation API

Ratchet Stop checks a license when `license/config.js` has `enforce: true` and `apiUrl` set.

## Request

`POST` your `apiUrl` with JSON:

```json
{
  "key": "user-license-key",
  "product": "ratchetstop",
  "extensionId": "chrome-extension-id"
}
```

## Response

```json
{
  "ok": true,
  "exp": 1893456000000
}
```

On failure:

```json
{
  "ok": false,
  "reason": "invalid"
}
```

`exp` is optional epoch milliseconds. The extension caches success and allows offline use for `graceHours` (default 72).

## Example (Node / Workers)

```javascript
export default {
  async fetch(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const { key, product } = await req.json();
    const allowed = product === 'ratchetstop' && KEYS.has(String(key));
    return Response.json(
      allowed
        ? { ok: true, exp: Date.now() + 30 * 86400000 }
        : { ok: false, reason: 'invalid' },
    );
  },
};
```

Store `KEYS` in your worker secrets / KV—never in the extension.

## Enable enforcement

1. Deploy the endpoint (HTTPS).
2. Edit `license/config.js`: `enforce: true`, `apiUrl: 'https://…'`.
3. Rebuild release: `npm run build:release`.
4. Users enter keys in the extension popup.
