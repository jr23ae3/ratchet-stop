#!/usr/bin/env bash
# Push Ratchet Stop to https://github.com/aethatsme (second GitHub account).
# Prerequisite: gh must be logged in AS aethatsme (not jr23ae3).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOGIN="$(gh api user -q .login 2>/dev/null || true)"
if [[ "$LOGIN" != "aethatsme" ]]; then
  echo "GitHub CLI is logged in as «${LOGIN:-unknown}», not aethatsme."
  echo "Run: gh auth login -h github.com -p https"
  echo "Sign in with the aethatsme account, then run this script again."
  exit 1
fi

if ! gh repo view aethatsme/ratchet-stop &>/dev/null; then
  echo "Creating private repo aethatsme/ratchet-stop…"
  gh repo create ratchet-stop --private --description "Ratchet Stop — Vest Markets Chrome extension"
fi

if ! git remote get-url aethatsme &>/dev/null; then
  git remote add aethatsme "https://github.com/aethatsme/ratchet-stop.git"
fi

echo "Pushing main and tags…"
git push -u aethatsme main
git push aethatsme --tags

if [[ -f release/ratchet-stop-extension.zip ]] || [[ -f ratchet-stop-v1.7.2-extension.zip ]]; then
  ZIP="ratchet-stop-v1.7.2-extension.zip"
  npm run build:release
  (cd release && zip -rq "../$ZIP" .)
  VER="$(node -p "require('./manifest.json').version")"
  TAG="v${VER}"
  if gh release view "$TAG" --repo aethatsme/ratchet-stop &>/dev/null; then
    gh release upload "$TAG" "$ZIP" --repo aethatsme/ratchet-stop --clobber
  else
    gh release create "$TAG" --repo aethatsme/ratchet-stop --title "Ratchet Stop $TAG" \
      --notes "Browser extension zip — unzip and Load unpacked in Chrome." "$ZIP"
  fi
  rm -f "$ZIP"
fi

echo "Done: https://github.com/aethatsme/ratchet-stop"
