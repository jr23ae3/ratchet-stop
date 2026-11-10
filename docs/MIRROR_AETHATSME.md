# Mirror to [aethatsme](https://github.com/aethatsme)

This machine’s `gh` CLI is often logged in as **jr23ae3**. GitHub does not allow one account to create repos on another user’s profile.

## One-time: sign in as aethatsme

```bash
gh auth login -h github.com -p https
```

Choose **aethatsme** when prompted.

Verify:

```bash
gh api user -q .login
# should print: aethatsme
```

## Push code, tags, and extension release

```bash
cd /Users/aep/Desktop/aetrades-market-copier
chmod +x scripts/sync-aethatsme.sh
./scripts/sync-aethatsme.sh
```

That script:

1. Creates **aethatsme/ratchet-stop** (private) if missing  
2. Adds remote `aethatsme`  
3. Pushes `main` and all tags  
4. Builds the extension zip and attaches a GitHub Release when possible  

## Both remotes

| Remote      | URL |
|------------|-----|
| `origin`   | `jr23ae3/ratchet-stop` |
| `aethatsme`| `aethatsme/ratchet-stop` |

Future updates after committing on `main`:

```bash
git push origin main --tags
./scripts/sync-aethatsme.sh
```

(With `gh` logged in as aethatsme for the sync script.)
