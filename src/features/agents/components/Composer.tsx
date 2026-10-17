import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { BookText, FileText, Folder, FolderGit2, Globe, ImagePlus, Loader2, Send, Square, SquareSlash, X, type LucideIcon } from 'lucide-react'
import type { Project } from '@shared/types/project'
import type { AgentCommand } from '@shared/types/agents'
import { base64Bytes, IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_IMAGES_BYTES, type ComposerImage, type ComposerRef, type ImageType } from '@shared/types/composer'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { loadDraft, promptHistory, rememberPrompt, saveDraft, useComposerPrefs } from '../composerPrefs'
import { loadMentions, rankMentions, tokenAt, type MentionItem } from '../mentions'

/** What a message carries besides its text. */
export interface ComposerExtra {
  refs: ComposerRef[]
  images: ComposerImage[]
}

/** An agent session's composer: `@` references, `/` commands, images, a draft of its own. */
export interface ComposerAgent {
  sessionId: string
  projectId: string
  commands: AgentCommand[]
  /** The agent takes images. */
  images: boolean
}

interface Attached extends ComposerImage {
  id: number
}

interface Suggestion {
  key: string
  icon: LucideIcon
  label: string
  detail: string
  pick: () => void
}

const REF_ICON: Record<ComposerRef['kind'], LucideIcon> = { file: FileText, folder: Folder, note: BookText, tab: Globe }
const MB = MAX_IMAGE_BYTES / 1024 / 1024

const readImage = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

let nextImage = 0

/**
 * Message input. Enter sends and Shift+Enter breaks the line (or ⌘Enter
 * sends, as set in Settings); ↑/↓ bring back earlier prompts; Stop while a
 * run is active. In an agent session also: `@` for files, folders, notes and
 * tabs, `/` for the agent's commands, images pasted, dropped or attached, and
 * an unsent draft kept per session.
 */
export function Composer({
  running,
  sending,
  disabled,
  projects,
  projectId,
  placeholder,
  agent,
  toolbar,
  onProject,
  onSend,
  onStop
}: {
  running: boolean
  sending: boolean
  disabled?: boolean
  /** Project context picker (Mindeck Assistant chats); agent sessions already have their project. */
  projects?: Project[]
  projectId?: string
  placeholder: string
  agent?: ComposerAgent
  /** Extra controls in the line below (an agent session's model and mode). */
  toolbar?: ReactNode
  onProject?: (id?: string) => void
  onSend: (text: string, extra: ComposerExtra) => Promise<boolean>
  onStop: () => void
}) {
  const t = useT()
  const sendKey = useComposerPrefs((s) => s.sendKey)
  // The session's unsent draft (the composer is mounted once per session).
  const [draft] = useState(() => (agent ? loadDraft(agent.sessionId) : { text: '', refs: [] }))
  const [text, setText] = useState(draft.text)
  const [refs, setRefs] = useState<ComposerRef[]>(draft.refs)
  const [images, setImages] = useState<Attached[]>([])
  const [error, setError] = useState<string>()
  const [token, setToken] = useState<ReturnType<typeof tokenAt>>(null)
  const [active, setActive] = useState(0)
  const [mentions, setMentions] = useState<MentionItem[]>()
  const [recalled, setRecalled] = useState(-1)
  const area = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const loading = useRef(false)

  useEffect(() => {
    const el = area.current!
    el.style.height = 'auto'
    el.style.height = `${Math.min(220, el.scrollHeight)}px`
  }, [text])

  useEffect(() => {
    if (agent) saveDraft(agent.sessionId, { text, refs })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the session id matters, not the agent object
  }, [agent?.sessionId, text, refs])

  // Each `@` looks up what can be referenced (files, notes and tabs come and go); the last list shows meanwhile.
  useEffect(() => {
    if (token?.trigger !== '@') {
      loading.current = false
      return
    }
    if (loading.current) return
    loading.current = true
    void loadMentions(agent!.projectId).then(setMentions)
  }, [token, agent])

  const suggestions: Suggestion[] = !token
    ? []
    : token.trigger === '@'
      ? rankMentions(mentions ?? [], token.query).map((m) => ({
          key: `${m.kind}:${m.path}`,
          icon: REF_ICON[m.kind],
          label: m.label,
          detail: m.detail,
          pick: () => mention(m)
        }))
      : agent!.commands
          .filter((c) => c.name.toLowerCase().includes(token.query.toLowerCase()))
          .map((c) => ({ key: c.name, icon: SquareSlash, label: `/${c.name}`, detail: c.description, pick: () => command(c) }))

  const typed = (value: string, caret: number) => {
    setText(value)
    setError(undefined)
    const next = agent ? tokenAt(value, caret) : null
    // Commands only from the agent's list.
    setToken(next?.trigger === '/' && !agent!.commands.length ? null : next)
    setActive(0)
  }

  const replaceToken = (insert: string) => {
    const end = token!.start + token!.query.length + 1
    const value = text.slice(0, token!.start) + insert + text.slice(end)
    setText(value)
    setToken(null)
    requestAnimationFrame(() => area.current?.setSelectionRange(token!.start + insert.length, token!.start + insert.length))
  }

  const mention = (m: MentionItem) => {
    replaceToken('')
    setRefs((list) => (list.some((r) => r.kind === m.kind && r.path === m.path) ? list : [...list, { kind: m.kind, path: m.path, label: m.label }]))
  }

  const command = (c: AgentCommand) => replaceToken(`/${c.name} `)

  const addImages = async (files: File[]) => {
    setError(undefined)
    if (!agent!.images) return setError(t.agents.noImages)
    const next = [...images]
    for (const file of files) {
      if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) {
        setError(t.agents.notAnImage(file.name))
        continue
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError(t.agents.imageTooLarge(file.name, MB))
        continue
      }
      if (next.length >= MAX_IMAGES) {
        setError(t.agents.tooManyImages(MAX_IMAGES))
        break
      }
      if (next.reduce((n, i) => n + base64Bytes(i.data), 0) + file.size > MAX_IMAGES_BYTES) {
        setError(t.agents.imagesTooLarge(MAX_IMAGES_BYTES / 1024 / 1024))
        break
      }
      try {
        const url = await readImage(file)
        next.push({ id: (nextImage += 1), name: file.name, mimeType: file.type as ImageType, data: url.slice(url.indexOf(',') + 1) })
      } catch {
        setError(t.agents.imageUnreadable(file.name))
      }
    }
    setImages(next)
  }

  const imageFiles = (list: FileList) => [...list].filter((f) => f.type.startsWith('image/'))

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFiles(e.clipboardData.files)
    if (!agent || !files.length) return
    e.preventDefault()
    void addImages(files)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!agent || !e.dataTransfer.files.length) return
    e.preventDefault()
    void addImages([...e.dataTransfer.files])
  }

  const empty = !text.trim() && !refs.length && !images.length

  const submit = async () => {
    if (empty || running || sending || disabled) return
    const sent = await onSend(text, { refs, images: images.map(({ name, mimeType, data }) => ({ name, mimeType, data })) })
    if (!sent) return
    rememberPrompt(text)
    setText('')
    setRefs([])
    setImages([])
    setToken(null)
    setRecalled(-1)
  }

  /** ↑ on the first line brings back the previous prompt (when the box is empty or shows one), ↓ goes forward again. */
  const recall = (e: KeyboardEvent<HTMLTextAreaElement>, step: 1 | -1): boolean => {
    const history = promptHistory()
    const el = e.currentTarget
    if (text && text !== history[recalled]) return false
    const onEdge = step === 1 ? !text.slice(0, el.selectionStart).includes('\n') : !text.slice(el.selectionEnd).includes('\n')
    const index = recalled + step
    if (!onEdge || index < -1 || index >= history.length) return false
    e.preventDefault()
    setRecalled(index)
    setText(index < 0 ? '' : history[index])
    return true
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (token && suggestions.length) {
      const n = suggestions.length
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        return setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        return suggestions[active].pick()
      }
    }
    if (token && e.key === 'Escape') {
      e.preventDefault()
      return setToken(null)
    }
    if (e.key === 'ArrowUp' && recall(e, 1)) return
    if (e.key === 'ArrowDown' && recall(e, -1)) return
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (sendKey === 'enter' && !e.shiftKey))) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="border-t border-hud/60 p-3" onDragOver={(e) => agent && e.preventDefault()} onDrop={onDrop}>
      <div className="relative rounded-lg border border-hud/70 bg-surface/70 px-2.5 py-2 focus-within:border-cyan/50">
        {token && suggestions.length > 0 && (
          <ul role="listbox" aria-label={token.trigger === '@' ? t.agents.references : t.agents.commands} className="absolute inset-x-0 bottom-full z-20 mb-1 max-h-64 overflow-y-auto rounded-md border border-hud/70 bg-elevated p-1 shadow-lg">
            {suggestions.map((s, i) => (
              <li
                key={s.key}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault()
                  s.pick()
                }}
                onMouseEnter={() => setActive(i)}
                className={cn('flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1', i === active && 'bg-cyan/[0.1]')}
              >
                <s.icon size={12} className="shrink-0 text-cyan" />
                <span className="shrink-0 font-sans text-[12.5px] text-text-primary">{s.label}</span>
                <span className="min-w-0 truncate font-mono text-[10.5px] text-text-muted">{s.detail}</span>
              </li>
            ))}
          </ul>
        )}
        {token?.trigger === '@' && !mentions && (
          <p className="absolute inset-x-0 bottom-full mb-1 flex items-center gap-2 rounded-md border border-hud/70 bg-elevated px-2 py-1.5 font-mono text-[11px] text-text-muted">
            <Loader2 size={11} className="animate-spin" /> {t.agents.loadingReferences}
          </p>
        )}
        {(refs.length > 0 || images.length > 0) && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {refs.map((r) => {
              const Icon = REF_ICON[r.kind]
              const label = r.label ?? r.path
              return (
                <span key={`${r.kind}:${r.path}`} title={r.path} className="flex max-w-[240px] items-center gap-1 rounded-sm border border-cyan/30 bg-cyan/[0.07] px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
                  <Icon size={11} className="shrink-0 text-cyan" />
                  <span className="truncate">{label}</span>
                  <button type="button" aria-label={t.agents.removeReference(label)} onClick={() => setRefs((list) => list.filter((x) => x !== r))} className="text-text-muted hover:text-text-primary">
                    <X size={10} />
                  </button>
                </span>
              )
            })}
            {images.map((img) => (
              <span key={img.id} className="group relative h-12 w-12 overflow-hidden rounded-sm border border-hud/70">
                <img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name} className="h-full w-full object-cover" />
                <button
                  type="button"
                  aria-label={t.agents.removeImage(img.name)}
                  onClick={() => setImages((list) => list.filter((x) => x.id !== img.id))}
                  className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-void/80 text-text-secondary hover:text-text-primary"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          {agent?.images && (
            <>
              <button
                type="button"
                aria-label={t.agents.attachImage}
                title={t.agents.attachImage}
                disabled={disabled}
                onClick={() => filePicker.current!.click()}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted hover:text-cyan disabled:opacity-40"
              >
                <ImagePlus size={15} />
              </button>
              <input
                ref={filePicker}
                type="file"
                accept={IMAGE_TYPES.join(',')}
                multiple
                hidden
                data-testid="image-input"
                onChange={(e) => {
                  void addImages([...e.target.files!])
                  e.target.value = ''
                }}
              />
            </>
          )}
          <textarea
            ref={area}
            aria-label={t.agents.message}
            rows={1}
            value={text}
            disabled={disabled}
            onChange={(e) => typed(e.target.value, e.target.selectionStart)}
            onKeyDown={onKey}
            onPaste={onPaste}
            onBlur={() => setToken(null)}
            placeholder={placeholder}
            className="max-h-[220px] min-h-[24px] flex-1 resize-none bg-transparent font-sans text-[13.5px] leading-6 text-text-primary outline-hidden placeholder:text-text-muted disabled:opacity-50"
          />
          {running ? (
            <button
              type="button"
              onClick={onStop}
              aria-label={t.agents.stop}
              title={t.agents.stopAgent}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-amber/50 bg-amber/10 text-amber hover:bg-amber/20"
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              aria-label={t.agents.send}
              disabled={empty || sending || disabled}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-cyan/50 bg-cyan/12 text-cyan hover:bg-cyan/20 disabled:opacity-40"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            </button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-1 font-mono text-[11px] text-danger">
          {error}
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-2">
        {onProject && (
          <Select
            variant="quiet"
            icon={FolderGit2}
            label={t.agents.projectContext}
            value={projectId ?? ''}
            onChange={(v) => onProject(v || undefined)}
            options={[{ value: '', label: t.agents.noProject }, ...projects!.map((p) => ({ value: p.id, label: p.name }))]}
          />
        )}
        {toolbar}
        <span className="ml-auto hidden font-mono text-[10px] text-text-muted sm:inline">{sendKey === 'enter' ? t.agents.enterHint : t.agents.modEnterHint}</span>
      </div>
    </div>
  )
}
