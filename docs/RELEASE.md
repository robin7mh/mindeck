# Releasing the desktop app

A tag `v<version>` builds Mindeck for every platform and publishes **one** GitHub release: [`.github/workflows/release.yml`](../.github/workflows/release.yml), configured by [`electron-builder.yml`](../electron-builder.yml).

| Platform | Built on | Downloads (same name in every release) | Update feed |
| --- | --- | --- | --- |
| macOS Apple silicon | `macos-latest` | `Mindeck-mac-arm64.dmg` (+ `Mindeck-mac-arm64.zip` for the updater) | `latest-mac.yml` |
| macOS Intel | `macos-latest` | `Mindeck-mac-x64.dmg` (+ `Mindeck-mac-x64.zip`) | `latest-mac.yml` |
| Windows x64 + arm64 | `windows-latest` | `Mindeck-Setup.exe` (one NSIS installer, installs the machine's architecture) | `latest.yml` |
| Linux x64 | `ubuntu-latest` | `Mindeck.AppImage`, `Mindeck.deb` | `latest-linux.yml` |
| Linux arm64 | `ubuntu-24.04-arm` | `Mindeck-arm64.AppImage`, `Mindeck-arm64.deb` | `latest-linux-arm64.yml` |

The website links `https://github.com/robin7mh/mindeck/releases/latest/download/<name>` — these names never change. The `.blockmap` files next to them let the updater download only what changed.

Installed apps check the feed 15 seconds after start and every four hours (or via Profile → *Check for updates*), download in the background and offer *Restart & update*. **The `.deb` can't replace itself**: there the app only checks and shows *New version … · download* (top bar and Profile), linking that version's `.deb`. AppImages, macOS and Windows update on their own.

## Secrets

Repository → Settings → Secrets and variables → Actions.

| Name | Kind | Needed for | What |
| --- | --- | --- | --- |
| `MINDECK_CLOUD_URL` | variable | every build | Where Mindeck Cloud lives (baked in) |
| `MINDECK_CLOUD_KEY` | secret | every build | The cloud's entitlement public key(s): `curl -s https://api.<domain>/v1/meta \| jq -r .entitlementPublicKey`. After a key rotation a list — PEM or base64 SPKI DER, comma- or line-separated, **the original key first**, the next key (from `keys:generate`) after it (docs/API.md §6.1). The build fails on a key it can't read |
| `CSC_LINK` | secret | macOS signing | "Developer ID Application" certificate as `.p12`, base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
| `CSC_KEY_PASSWORD` | secret | macOS signing | The `.p12`'s password |
| `APPLE_ID` | secret | macOS notarization | The Apple ID of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | secret | macOS notarization | An app-specific password for it (<https://account.apple.com> → Sign-In and Security) |
| `APPLE_TEAM_ID` | secret | macOS notarization | The 10-character team ID (developer.apple.com → Membership) |
| `WIN_CSC_LINK` | secret | Windows signing (certificate) | Code signing certificate as `.pfx`, base64-encoded |
| `WIN_CSC_KEY_PASSWORD` | secret | Windows signing (certificate) | The `.pfx`'s password |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | secrets | Windows signing (Azure Trusted Signing) | A Microsoft Entra app registration with the *Trusted Signing Certificate Profile Signer* role |
| `AZURE_ENDPOINT` | secret | Azure Trusted Signing | The account's region endpoint, e.g. `https://weu.codesigning.azure.net` |
| `AZURE_CODE_SIGNING_ACCOUNT` | secret | Azure Trusted Signing | The Trusted Signing account name |
| `AZURE_CERT_PROFILE` | secret | Azure Trusted Signing | The certificate profile name |
| `AZURE_PUBLISHER_NAME` | secret | Azure Trusted Signing | The certificate's subject CN, exactly (the updater checks updates against it) |

`GITHUB_TOKEN` (automatic) publishes the release. Windows is signed with `WIN_CSC_LINK` when it is set, else with Azure Trusted Signing when **all** `AZURE_*` secrets are set. Linux packages aren't signed.

**Missing signing secrets stop a release** (a tag): the updater would hand the unsigned installers to every user. A manual run (*Run workflow*) still builds without them and says so with a warning:

- no `CSC_LINK`: the macOS app is unsigned and not notarized — Gatekeeper blocks it ("damaged / can't be opened") on every other Mac.
- `CSC_LINK` but incomplete `APPLE_*`: signed, not notarized — Gatekeeper still warns.
- no Windows signing: the installer works, SmartScreen warns ("Windows protected your PC") until it gains reputation.

Before anything is built, the workflow runs `npm run typecheck` and the unit tests (`npm run test:coverage`); the CD workflow does the same before it publishes the Docker image. Make both CI checks required for `main` and `develop` (Settings → Branches → branch protection) so nothing lands there untested.

## One-time setup

1. **Apple Developer Program** (99 $/year, approval can take 1–2 days): <https://developer.apple.com/programs/enroll/>
2. **Certificate:** in Xcode → Settings → Accounts → *Manage Certificates* → `+` → **Developer ID Application**. Export it from the Keychain as `.p12` with a password → `CSC_LINK` / `CSC_KEY_PASSWORD`.
3. **Notarization:** an app-specific password for the Apple ID → `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`.
4. **Windows:** an OV/EV code signing certificate (`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD`) — or Azure Trusted Signing (cheaper, no hardware token): create a Trusted Signing account and certificate profile in Azure, an app registration with the signer role, and set the `AZURE_*` secrets.

## Each release

1. Bump `version` in `package.json` (e.g. `0.1.0` → `1.0.0`), commit, push.
2. Tag and push the tag — it must match `package.json`, the workflow checks:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

3. The workflow runs the tests, builds the Remote-SSH / Dev Containers server packages (linux x64 + arm64, each started once as a check), then the four app jobs (macOS ~20 min with notarization) with the packages' SHA-256 baked in, checks that every download, feed and server package is there, and publishes the release (a tag with `-`, like `v1.1.0-beta.1`, becomes a pre-release — the updater skips those).
4. Check once on a second Mac and a Windows PC: download from the website, open — no Gatekeeper / SmartScreen warning — and sign in.
5. **Remote-SSH / Dev Containers** need nothing by hand: the release carries `mindeck-server-<version>-linux-x64.tar.gz` and `…-linux-arm64.tar.gz`. The app downloads the package for the remote machine's architecture from `releases/download/v<version>/` the first time it connects there (kept in `~/Mindeck/data/remote/`), checks it against the SHA-256 it was built with (`MINDECK_REMOTE_SHA256_X64` / `_ARM64`) every time before it installs it in `~/.mindeck-server/<version>` on the remote side — a package that was replaced, on GitHub or on disk, is refused. That also means a package can't be rebuilt and re-uploaded to an existing release: release a new version. (`npm run remote:bundle` builds them locally for dev runs, which check nothing.)

A manual run (Actions → Release → *Run workflow*) builds everything as workflow artifacts without publishing — to try a build before tagging.

## What the build bakes in

- `MINDECK_CLOUD_URL` / `MINDECK_CLOUD_KEY` → where the app checks the license, and the key it verifies entitlements with. A packaged app always enforces the license and ignores these variables at runtime.

## Local builds

```bash
npm run dist:mac      # on a Mac; unsigned: CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac -- -c.mac.identity=null
npm run dist:win      # on Windows
npm run dist:linux    # on Linux, for the machine's architecture
```

Set `MINDECK_CLOUD_URL` (e.g. `http://localhost:8080`) for a build against a local cloud.
