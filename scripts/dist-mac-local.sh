#!/usr/bin/env bash
# npm run dist:mac:local: a Mindeck .dmg for this Mac (Apple silicon), with Mindeck Cloud built in.
# It runs here, but isn't notarized, so Gatekeeper blocks it on other Macs. A release for everyone
# goes through .github/workflows/release.yml (docs/RELEASE.md).
#
# Signing: with a certificate from this Mac's keychain when there is one (Developer ID Application
# first, else Apple Development — Xcode makes one for free; MINDECK_SIGN_IDENTITY picks another).
# The app then keeps one identity from build to build, so the keychain's "Always Allow" for
# "mindeck Safe Storage" holds. Without a certificate it is signed ad hoc: every build is a new app to
# macOS, which asks for the keychain password again after each one.
#
# Never unsigned: electron-builder flips Electron's fuses inside the framework binary, which breaks
# its signature, and macOS kills an unsigned build at launch ("Code Signature Invalid"). Ad hoc
# without the hardened runtime: its library validation needs a Team ID ("different Team IDs").
#
# Output: release/Mindeck-mac-arm64.dmg
set -euo pipefail
cd "$(dirname "$0")/.."

export MINDECK_CLOUD_URL="${MINDECK_CLOUD_URL:-https://api.mindeck.de}"
# The key is always fetched fresh: a stale or broken MINDECK_CLOUD_KEY in the shell is ignored.
MINDECK_CLOUD_KEY="$(curl -fsS "$MINDECK_CLOUD_URL/v1/meta" | jq -r '.entitlementPublicKey // empty')"
if [ -z "$MINDECK_CLOUD_KEY" ]; then
  echo "Couldn't read the entitlement key from $MINDECK_CLOUD_URL/v1/meta" >&2
  exit 1
fi
export MINDECK_CLOUD_KEY
echo "Mindeck Cloud: $MINDECK_CLOUD_URL"

identity="${MINDECK_SIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  identity="$(awk '/"Developer ID Application: / { print $2; exit }' <<<"$identities")"
  [ -n "$identity" ] || identity="$(awk '/"Apple Development: / { print $2; exit }' <<<"$identities")"
fi
if [ -n "$identity" ]; then
  echo "Signing with: $(security find-identity -v -p codesigning | awk -F'"' -v id="$identity" 'index($0, id) { print $2; exit }')"
  sign=(-c.mac.identity="$identity")
else
  echo "No signing certificate in the keychain: signed ad hoc (macOS asks for the keychain again after each build)"
  sign=(-c.mac.identity=- -c.mac.hardenedRuntime=false)
fi

npm run build
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --publish never \
  -c.mac.target.target=dmg -c.mac.target.arch=arm64 "${sign[@]}"

echo
echo "Done: release/Mindeck-mac-arm64.dmg (open it and drag Mindeck to Applications)"
