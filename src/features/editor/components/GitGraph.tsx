import { GitCommitHorizontal, GitGraph as GraphIcon } from 'lucide-react'
import type { ScmCommit } from '@shared/types/scm'
import { GRAPH_COLORS } from '@shared/types/memory'
import { cn } from '@/lib/cn'
import { intlLocale, useT } from '@/lib/i18n'
import { relativeTime } from '@/features/agents/format'
import { useScm } from '../scm'

const ROW = 28
const LANE = 14
const PAD = 10
/** Lanes beyond this are squeezed into the last one (very wide histories stay readable). */
const MAX_LANES = 16

export interface GraphRow {
  commit: ScmCommit
  /** The commit's lane. */
  lane: number
  /** Per lane, the commit it waits for — above and below this row. */
  before: (string | null)[]
  after: (string | null)[]
  /** Lanes the merge parents (second and later) continue in. */
  merges: number[]
}

/** The classic lane layout: each commit sits in the lane that waits for it; parents continue below. */
export function layoutGraph(commits: ScmCommit[]): GraphRow[] {
  const lanes: (string | null)[] = []
  const free = () => {
    const i = lanes.indexOf(null)
    return i < 0 ? lanes.length : i
  }
  return commits.map((commit) => {
    let lane = lanes.indexOf(commit.hash)
    if (lane < 0) {
      lane = free()
      lanes[lane] = commit.hash
    }
    const before = [...lanes]
    // Other lanes that waited for this commit end here (branches joining).
    for (let k = 0; k < lanes.length; k += 1) if (k !== lane && lanes[k] === commit.hash) lanes[k] = null
    lanes[lane] = commit.parents[0] ?? null
    const merges = commit.parents.slice(1).map((p) => {
      let j = lanes.indexOf(p)
      if (j < 0) {
        j = free()
        lanes[j] = p
      }
      return j
    })
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    return { commit, lane, before, after: [...lanes], merges }
  })
}

const x = (lane: number) => PAD + Math.min(lane, MAX_LANES) * LANE
const color = (lane: number) => (lane === 0 ? 'rgb(var(--accent-cyan))' : `rgb(var(--graph-${GRAPH_COLORS[lane % GRAPH_COLORS.length]}))`)

function Lanes({ row, width }: { row: GraphRow; width: number }) {
  const mid = ROW / 2
  const lines: { d: string; lane: number }[] = []
  row.before.forEach((h, k) => {
    if (h) lines.push({ d: `M${x(k)} 0 L${x(h === row.commit.hash ? row.lane : k)} ${mid}`, lane: k })
  })
  row.after.forEach((h, k) => {
    if (h) lines.push({ d: `M${x(k === row.lane || !row.before[k] ? row.lane : k)} ${mid} L${x(k)} ${ROW}`, lane: k })
  })
  for (const j of row.merges) lines.push({ d: `M${x(row.lane)} ${mid} L${x(j)} ${ROW}`, lane: j })
  return (
    <svg width={width} height={ROW} className="shrink-0" aria-hidden>
      {lines.map((l, i) => (
        <path key={i} d={l.d} stroke={color(l.lane)} strokeWidth={1.6} fill="none" strokeLinecap="round" />
      ))}
      <circle cx={x(row.lane)} cy={mid} r={row.commit.parents.length > 1 ? 3 : 4} fill="rgb(var(--bg-panel))" stroke={color(row.lane)} strokeWidth={2} />
    </svg>
  )
}

/** A ref as a small badge: HEAD → branch, remote branches, tags. */
function Ref({ name }: { name: string }) {
  const head = name.startsWith('HEAD -> ')
  const tag = name.startsWith('tag: ')
  const label = head ? name.slice('HEAD -> '.length) : tag ? name.slice('tag: '.length) : name
  return (
    <span
      className={cn(
        'shrink-0 rounded-sm border px-1 font-mono text-[10px]',
        head ? 'border-cyan/50 bg-cyan/10 text-cyan' : tag ? 'border-amber/40 text-amber' : 'border-hud/60 text-text-secondary'
      )}
    >
      {label}
    </span>
  )
}

/** VS Code's Git Graph: every branch's history as lanes, and the selected commit's details and files. */
export function GitGraph() {
  const t = useT()
  const { log, selected, detail } = useScm()
  const rows = layoutGraph(log)
  const width = PAD * 2 + Math.min(MAX_LANES, Math.max(1, ...rows.map((r) => Math.max(r.before.length, r.after.length)))) * LANE

  if (!log.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <GraphIcon size={26} className="text-text-muted" />
        <p className="font-sans text-[13px] text-text-secondary">{t.scm.graphEmpty}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <ul role="listbox" aria-label={t.scm.panes.graph} className="min-w-0 flex-1 overflow-y-auto py-1">
        {rows.map((row) => (
          <li
            key={row.commit.hash}
            role="option"
            aria-selected={row.commit.hash === selected}
            onClick={() => void useScm.getState().select(row.commit.hash)}
            className={cn('flex cursor-pointer items-center gap-2 pr-3 hover:bg-elevated/40', row.commit.hash === selected && 'bg-cyan/8')}
            style={{ height: ROW }}
          >
            <Lanes row={row} width={width} />
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {row.commit.refs.map((r) => (
                <Ref key={r} name={r} />
              ))}
              <span className="min-w-0 truncate font-sans text-[12.5px] text-text-primary">{row.commit.subject}</span>
            </span>
            <span className="hidden w-28 shrink-0 truncate font-sans text-[11px] text-text-muted lg:block">{row.commit.author}</span>
            <span className="w-20 shrink-0 text-right font-mono text-[10.5px] text-text-muted">{relativeTime(new Date(row.commit.date).toISOString())}</span>
            <span className="w-14 shrink-0 text-right font-mono text-[10.5px] text-text-muted">{row.commit.hash.slice(0, 7)}</span>
          </li>
        ))}
      </ul>

      {detail && (
        <aside className="flex w-80 shrink-0 flex-col border-l border-hud/60">
          <div className="space-y-1 border-b border-hud/50 p-3">
            <p className="whitespace-pre-wrap wrap-break-word font-sans text-[13px] font-medium text-text-primary">{detail.message}</p>
            <p className="font-sans text-[11.5px] text-text-secondary">
              {detail.author} · {new Date(detail.date).toLocaleString(intlLocale())}
            </p>
            <p className="flex items-center gap-1 font-mono text-[10.5px] text-text-muted">
              <GitCommitHorizontal size={11} /> {detail.hash}
            </p>
          </div>
          <p className="px-3 pt-2 font-mono text-[10.5px] text-text-muted">{t.scm.filesChanged(detail.files.length)}</p>
          <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {detail.files.map((f) => {
              const name = f.path.slice(f.path.lastIndexOf('/') + 1)
              return (
                <li key={f.path}>
                  <button
                    type="button"
                    title={f.from ? `${f.from} → ${f.path}` : f.path}
                    onClick={() => void useScm.getState().openDiff(f, { kind: 'commit', hash: detail.hash }, `${name} (${detail.hash.slice(0, 7)})`)}
                    className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-left hover:bg-elevated/50"
                  >
                    <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-text-primary">{name}</span>
                    <span className="min-w-0 truncate font-mono text-[10px] text-text-muted">{f.path.slice(0, f.path.length - name.length)}</span>
                    <span className="w-14 shrink-0 text-right font-sans text-[10.5px] text-text-muted">{t.scm.change[f.change]}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </aside>
      )}
    </div>
  )
}
