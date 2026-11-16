import { ExternalLink, Github, Gitlab, type LucideIcon } from 'lucide-react'

/**
 * "GitHub", "GitLab" — or the host — and an icon, for a link to a repo's web
 * page. Undefined for anything that is no valid web address (a remote such as
 * `git@exa mple:a/b` comes from the repo's own config): then there is no link.
 */
export function repoLink(url: string): { label: string; Icon: LucideIcon } | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  const host = parsed.hostname
  if (host === 'github.com') return { label: 'GitHub', Icon: Github }
  if (host.startsWith('gitlab.')) return { label: 'GitLab', Icon: Gitlab }
  return { label: host, Icon: ExternalLink }
}
