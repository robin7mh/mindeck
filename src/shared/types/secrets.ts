// Names that hold keys and credentials, judged per path segment. Pure module
// (no DOM/Node/Electron): the core's rules for paired devices and the
// renderer's first-commit check share it.

/**
 * Names a paired device never reads, anywhere — and a first commit asks
 * about: keys, credentials, keychains and browser profiles (compared per
 * path segment, ignoring case).
 */
const DENIED: readonly RegExp[] = [
  /^\.(ssh|aws|gnupg|azure|kube|docker|mozilla)$/,
  // A repository's own data: remote URLs carry tokens (`https://x-access-token:ghp_…@github.com`) — scm:* reads git for devices.
  /^\.git$/,
  /^\.env/,
  /^\.(netrc|pgpass|git-credentials|npmrc|pypirc|yarnrc|yarnrc\.yml|htpasswd|terraformrc|dockercfg|boto|s3cfg|my\.cnf)$/,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx|keychain|keychain-db)$/,
  // Terraform state (every secret of the infrastructure), cloud credentials and service accounts, app secrets.
  /\.tfstate(\..*)?$/,
  /^credentials.*\.json$/,
  /service[-_]?account.*\.json$/,
  /^secrets?\.(ya?ml|json)$/,
  /^wp-config\.php$/,
  // SSH keys (`id_rsa`, `id_ed25519.pub`, `id_github`) — not source files such as `id_utils.py`.
  /^id_[^.]*(\.pub)?$/,
  /^keychains$/,
  /^(google-chrome|chromium|bravesoftware|vivaldi)$/,
  /^(cookies|login data|web data|key4\.db|logins\.json|cookies\.sqlite)$/
]

/** A file or folder name on the deny list (keys, credentials, browser profiles), ignoring case. */
export function isDeniedName(name: string): boolean {
  return DENIED.some((re) => re.test(name.toLowerCase()))
}
