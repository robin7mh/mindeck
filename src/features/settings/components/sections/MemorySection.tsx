import { useEffect, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { ipc, isDesktop } from '@shared/ipc/client'
import type { VaultStatus } from '@shared/types/memory'
import { FolderPicker } from '@/components/ui/FolderPicker'
import { useT } from '@/lib/i18n'
import { useSession } from '@/features/session/store'
import { Group, Row, SectionHeader, btn } from '../ui'

/** Settings → Memory: where the vault is, showing it, and choosing another folder. */
export function MemorySection() {
  const t = useT()
  const s = t.settings
  const platform = useSession((st) => st.info?.platform)
  const [vault, setVault] = useState<VaultStatus>()
  const [browsing, setBrowsing] = useState(false)
  const [error, setError] = useState<string>()
  const desktop = isDesktop()

  useEffect(() => {
    void ipc('memory:status').then(setVault, (e: Error) => setError(e.message))
  }, [])

  const choose = async (path?: string) => {
    setError(undefined)
    try {
      const next = await (path ? ipc('memory:setVault', { path }) : ipc('memory:pickVault'))
      if (next) setVault(next)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <>
      <SectionHeader title={s.sections.memory.title} intro={s.sections.memory.intro} />
      <Group title={s.groups.location}>
        <Row
          label={s.vault}
          hint={
            vault ? (
              <>
                <span className="block break-all font-mono text-[12px]">{vault.root}</span>
                <span className="block">
                  {vault.exists ? s.notes(vault.noteCount) : s.notCreated} · {vault.isDefault ? s.defaultLocation : s.customFolder}
                </span>
              </>
            ) : (
              t.common.loading
            )
          }
          align="start"
        >
          <div className="flex flex-wrap gap-2">
            {desktop && vault?.exists && (
              <button type="button" className={btn} onClick={() => void ipc('memory:reveal').catch((e: Error) => setError(e.message))}>
                <FolderOpen size={14} /> {platform === 'darwin' ? s.revealFinder : s.revealFolder}
              </button>
            )}
            <button type="button" className={btn} onClick={() => (desktop ? void choose() : setBrowsing(true))}>
              {s.chooseFolder}
            </button>
          </div>
        </Row>
      </Group>
      {error && <p className="px-1 font-mono text-[12px] text-danger">{error}</p>}
      {browsing && (
        <FolderPicker
          title={s.chooseVault}
          confirmLabel={s.useAsVault}
          onClose={() => setBrowsing(false)}
          onPick={(path) => {
            setBrowsing(false)
            void choose(path)
          }}
        />
      )}
    </>
  )
}
