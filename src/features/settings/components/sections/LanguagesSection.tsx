import { useEffect, useState } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { errorMessage, ipc, onEvent } from '@shared/ipc/client'
import type { LanguageStatus, ToolState } from '@shared/types/languages'
import { useT } from '@/lib/i18n'
import { useLanguages } from '@/features/editor/languages'
import { Chip, Group, Pill, SectionHeader, btn } from '../ui'

type Part = 'server' | 'debugger'
type Kind = 'ready' | 'install' | 'needs'

/** Where a toolchain is to be had — for "Install go first". */
const GUIDES: Record<string, string> = {
  go: 'https://go.dev/dl/',
  rustup: 'https://rustup.rs/',
  npm: 'https://nodejs.org/',
  dotnet: 'https://dotnet.microsoft.com/download',
  java: 'https://adoptium.net/',
  php: 'https://www.php.net/downloads',
  python: 'https://www.python.org/downloads/',
  python3: 'https://www.python.org/downloads/',
  gem: 'https://www.ruby-lang.org/en/downloads/',
  brew: 'https://brew.sh/',
  scoop: 'https://scoop.sh/',
  winget: 'https://learn.microsoft.com/windows/package-manager/winget/'
}

const parts = (lang: LanguageStatus): [Part, ToolState][] => [['server', lang.server], ...(lang.debugger ? [['debugger', lang.debugger] as [Part, ToolState]] : [])]

/**
 * Which list a language belongs in: something to install with a click, all
 * there (or all that can be — the rest needs its toolchain), or nothing until
 * the language itself is on this machine.
 */
export function kindOf(lang: LanguageStatus): Kind {
  const states = parts(lang).map(([, tool]) => tool.state)
  if (states.includes('missing')) return 'install'
  if (states.includes('ready')) return 'ready'
  return 'needs'
}

/** Settings → Languages & debuggers: each language's server and debugger, and installing what is missing. */
export function LanguagesSection() {
  const t = useT()
  const l = t.languages
  const s = t.settings
  const [list, setList] = useState<LanguageStatus[]>()
  const [busy, setBusy] = useState<string>()
  const [log, setLog] = useState<{ id: string; lines: string[] }>()
  const [error, setError] = useState<{ id: string; message: string }>()

  const load = () =>
    ipc('tools:status').then(
      (status) => setList(status),
      (err: unknown) => setError({ id: '', message: errorMessage(err) })
    )

  useEffect(() => {
    void load()
    return onEvent('tools:progress', ({ id, line }) => setLog((prev) => ({ id, lines: [...(prev?.id === id ? prev.lines : []), line].slice(-8) })))
  }, [])

  /** Installs whatever of a language is missing — its server, then its debugger. */
  const install = async (lang: LanguageStatus) => {
    setBusy(lang.id)
    setError(undefined)
    setLog({ id: lang.id, lines: [] })
    try {
      for (const [part, tool] of parts(lang)) {
        if (tool.state !== 'missing') continue
        const updated = await ipc('tools:install', { id: lang.id, part })
        setList((prev) => prev?.map((x) => (x.id === lang.id ? updated : x)))
        // Files already open in the editor pick up their new server — even if the next part then fails.
        useLanguages.getState().toolsChanged()
      }
      setLog(undefined)
    } catch (err) {
      setError({ id: lang.id, message: errorMessage(err) })
    } finally {
      setBusy(undefined)
    }
  }

  /** What a tool that isn't there needs: its toolchain, or what it comes with. */
  const need = (tool: ToolState) => (tool.state === 'toolchain' ? l.needs(tool.requires!) : l.manual)

  const right = (lang: LanguageStatus, kind: Kind) => {
    if (kind === 'install')
      return (
        <button type="button" className={btn} disabled={!!busy} aria-label={l.installTool(lang.name)} onClick={() => void install(lang)}>
          {busy === lang.id ? <Loader2 size={14} className="animate-spin text-cyan" /> : <Download size={14} className="text-cyan" />} {l.install}
        </button>
      )
    if (kind === 'ready') {
      const off = parts(lang).find(([, tool]) => tool.state !== 'ready')?.[1]
      return off ? <Pill tone="warn">{s.partly(off.name, need(off))}</Pill> : <Pill tone="ok">{s.toolReady}</Pill>
    }
    const tool = lang.server.state === 'toolchain' ? lang.server : (lang.debugger ?? lang.server)
    const guide = tool.requires ? GUIDES[tool.requires] : undefined
    return (
      <>
        <span className="font-sans text-[13px] text-text-secondary">{tool.state === 'toolchain' ? s.installFirst(tool.requires!) : l.manual}</span>
        {guide && (
          <a href={guide} target="_blank" rel="noreferrer" className={btn}>
            {s.guide}
          </a>
        )}
      </>
    )
  }

  const group = (kind: Kind, title: (n: number) => string) => {
    const langs = list?.filter((lang) => kindOf(lang) === kind) ?? []
    if (!langs.length) return null
    return (
      <Group title={title(langs.length)}>
        {langs.map((lang) => (
          <div key={lang.id} className="border-t border-hud/45 px-5 py-3 first:border-t-0">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <p className="w-[110px] font-sans text-[14px] font-medium text-text-primary">{lang.name}</p>
              {parts(lang).map(([part, tool]) => (
                <Chip key={part} title={tool.command}>
                  {tool.name}
                </Chip>
              ))}
              <div className="ml-auto flex items-center gap-3">{right(lang, kind)}</div>
            </div>
            {log?.id === lang.id && log.lines.length > 0 && (
              <pre aria-label={l.log} className="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md bg-void/60 p-2 font-mono text-[11px] text-text-muted">
                {log.lines.join('\n')}
              </pre>
            )}
            {error?.id === lang.id && (
              <p role="alert" className="mt-2 whitespace-pre-wrap font-mono text-[11.5px] text-danger">
                {error.message}
              </p>
            )}
          </div>
        ))}
      </Group>
    )
  }

  return (
    <>
      <SectionHeader
        title={s.sections.languages.title}
        intro={s.sections.languages.intro}
        action={
          <button type="button" className={btn} onClick={() => void load()}>
            <RefreshCw size={14} /> {l.refresh}
          </button>
        }
      />
      {error?.id === '' && <p className="font-sans text-[13px] text-danger">{error.message}</p>}
      {!list && !error && <Loader2 size={18} aria-label={t.common.loading} className="animate-spin text-text-muted" />}
      {group('ready', s.groups.ready)}
      {group('install', s.groups.installable)}
      {group('needs', s.groups.needsFirst)}
    </>
  )
}
