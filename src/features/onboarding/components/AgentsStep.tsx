import { useEffect, useState, type ReactNode } from 'react'
import { Check, Copy, Loader2, Play, RefreshCw } from 'lucide-react'
import { ipc } from '@shared/ipc/client'
import type { RuntimeInfo } from '@shared/types/languages'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useAgents } from '@/features/agents/sessions'
import { useSession } from '@/features/session/store'
import { useTerminals } from '@/features/terminal/store'
import { XtermPane } from '@/features/terminal/components/XtermPane'
import { quietButton } from '@/features/cloud/components/CloudForms'
import { guides, untilDone, type Machine } from '../guides'

const small = 'flex shrink-0 items-center gap-1 rounded-sm border border-hud/60 px-1.5 py-1 font-sans text-[11px] text-text-secondary transition-colors hover:border-hud-strong/80 hover:text-text-primary'

/** A command line: copy it, or run it in a terminal right here. `note`: a line about it underneath. */
function CommandLine({ label, command, note, onRun }: { label: string; command: string; note?: string; onRun: (command: string) => void }) {
  const o = useT().onboarding
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = () =>
    navigator.clipboard.writeText(command).then(
      () => setCopied(true),
      () => {}
    )
  return (
    <>
      <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
        <span className="w-20 shrink-0 font-sans text-[11px] text-text-muted">{label}</span>
        <code title={command} className="min-w-0 flex-1 truncate rounded-sm border border-hud/50 bg-void/50 px-2 py-1 font-mono text-[11px] text-text-primary">
          {command}
        </code>
        <button type="button" aria-label={o.copy(command)} title={copied ? o.copied : undefined} onClick={() => void copy()} className={small}>
          {copied ? <Check size={12} className="text-green" /> : <Copy size={12} />}
        </button>
        <button type="button" aria-label={o.run(command)} onClick={() => onRun(command)} className={small}>
          <Play size={12} /> {o.runShort}
        </button>
      </div>
      {note && <p className="mt-1 pl-[86px] font-sans text-[11px] text-text-muted">{note}</p>}
    </>
  )
}

type Tone = 'ok' | 'warn' | 'off'

/** One program: whether it is there (and signed in), and the command that gets it there. */
function Row({ name, tone, status, children }: { name: string; tone: Tone; status: string; children?: ReactNode }) {
  return (
    <li className="rounded-md border border-hud/50 p-2.5">
      <div className="flex items-center gap-2">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', tone === 'ok' ? 'bg-green' : tone === 'warn' ? 'bg-amber' : 'bg-text-muted')} />
        <span className="font-sans text-[13px] font-medium text-text-primary">{name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-muted">{status}</span>
      </div>
      {children}
    </li>
  )
}

/**
 * Setup → coding agents: Claude Code, Codex and Gemini CLI (installed? signed
 * in, as far as each tells?) and Node.js — each with the command that installs
 * it on this machine or signs in, to copy or to run in a terminal here. Once a
 * command run here succeeded, its shell ends and the step looks again.
 */
export function AgentsStep() {
  const t = useT()
  const o = t.onboarding
  const platform = useSession((s) => s.info?.platform) ?? ''
  const availability = useAgents((s) => s.availability)
  const detecting = useAgents((s) => s.detecting)
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>()
  const [tabId, setTabId] = useState<string>()
  const [failed, setFailed] = useState(false)
  const tab = useTerminals((s) => s.tabs.find((x) => x.id === tabId))
  const terminalError = useTerminals((s) => s.error)

  const check = () => {
    void useAgents.getState().detect()
    ipc('tools:runtimes').then(setRuntimes, () => setRuntimes([]))
  }
  useEffect(check, [])

  const run = async (command: string) => {
    const opened = await useTerminals.getState().run(untilDone(command, platform))
    setTabId(opened?.id)
    setFailed(!opened)
  }
  const onRun = (command: string) => void run(command)
  // The command's shell ended (it succeeded): installed or signed in now?
  const exited = tab?.exitCode !== undefined
  useEffect(() => {
    if (exited) check()
  }, [exited])
  const found = (name: string) => runtimes?.find((r) => r.name === name && r.found)
  const node = found('node')
  const npm = found('npm')
  const machine: Machine = { platform, ...(npm ? { npm: { globalWritable: npm.globalWritable } } : {}), brew: !!found('brew') }

  return (
    <div>
      <div className="mb-3 flex items-start gap-3">
        <p className="flex-1 font-sans text-[13px] text-text-secondary">{o.agentsIntro}</p>
        <button type="button" disabled={detecting || !runtimes} onClick={check} className={cn(quietButton, 'py-1.5!')}>
          <RefreshCw size={12} className={cn(detecting && 'animate-spin')} /> {o.checkAgain}
        </button>
      </div>
      {!runtimes ? (
        <p className="flex items-center gap-2 font-mono text-[11px] text-text-muted">
          <Loader2 size={12} className="animate-spin" /> {o.checking}
        </p>
      ) : (
        <ul className="space-y-2">
          {guides(machine).map((guide) => {
            if (guide.id === 'node') {
              return (
                <Row key={guide.id} name={guide.name} tone={node ? 'ok' : 'off'} status={node ? o.installed(node.version) : o.notInstalled}>
                  {!node && <p className="mt-1.5 font-sans text-[11px] text-text-muted">{guide.install ? o.nodeHint : `${o.nodeHint} ${o.nodeDownload}`}</p>}
                  {!node && guide.install && <CommandLine label={o.install} command={guide.install} onRun={onRun} />}
                </Row>
              )
            }
            const agent = availability.find((a) => a.kind === guide.id)
            if (!agent?.installed) {
              return (
                <Row key={guide.id} name={guide.name} tone="off" status={guide.npm && !node ? `${o.notInstalled} · ${o.needsNode}` : o.notInstalled}>
                  <CommandLine label={o.install} command={guide.install!} note={guide.sudo ? o.sudoHint : undefined} onRun={onRun} />
                </Row>
              )
            }
            const version = o.installed(agent.version)
            return (
              <Row
                key={guide.id}
                name={guide.name}
                tone={agent.signedIn ? 'ok' : 'warn'}
                status={`${version} · ${agent.signedIn ? o.signedIn(guide.id === 'claude-code' ? agent.account : undefined) : o.notSignedIn}`}
              >
                {!agent.signedIn && <CommandLine label={o.signIn} command={guide.signIn!} onRun={onRun} />}
              </Row>
            )
          })}
        </ul>
      )}
      {tab && (
        <div className="mt-3">
          <p className="mb-1 font-sans text-[11.5px] text-text-muted">{o.terminalHint}</p>
          <div className="grid h-56 grid-rows-1 overflow-hidden rounded-md border border-hud/60 bg-void/60">
            <XtermPane tab={tab} label={tab.title} active framed={false} />
          </div>
        </div>
      )}
      {failed && <p className="mt-2 font-mono text-[11px] text-danger">{terminalError}</p>}
    </div>
  )
}
