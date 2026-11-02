import { useT } from '@/lib/i18n'
import { useAssistant } from '../store'
import { ApprovalCard } from './ApprovalCard'

/**
 * Pending approvals float above every module, so an agent never waits
 * unseen — on the desktop, in a browser and on a phone alike.
 */
export function ApprovalToasts({ hideConversation }: { hideConversation?: string }) {
  const t = useT()
  const pending = useAssistant((s) => s.pending)
  const respond = useAssistant((s) => s.respond)
  const visible = pending.filter((p) => p.conversationId !== hideConversation)
  if (!visible.length) return null
  return (
    <div className="pointer-events-none fixed bottom-12 right-3 z-40 flex w-[min(380px,calc(100vw-24px))] flex-col gap-2">
      {visible.slice(0, 3).map((req) => (
        <div key={req.id} className="pointer-events-auto shadow-panel">
          <ApprovalCard request={req} compact onRespond={(d) => void respond(req.id, d)} />
        </div>
      ))}
      {visible.length > 3 && (
        <p className="pointer-events-auto self-end rounded-sm bg-surface/90 px-2 py-0.5 font-mono text-[10px] text-text-muted">
          {t.agents.moreWaiting(visible.length - 3)}
        </p>
      )}
    </div>
  )
}
