import { Sparkles } from 'lucide-react'
import { isDesktop } from '@shared/ipc/client'
import { Card } from '@/components/ui/Card'
import { useT } from '@/lib/i18n'
import { quietButton } from '@/features/cloud/components/CloudForms'
import { useOnboarding } from '../store'

/** Settings → Setup: the first-start setup, once more (desktop window). */
export function OnboardingCard() {
  const o = useT().onboarding
  if (!isDesktop()) return null
  return (
    <Card icon={Sparkles} title={o.settingsCard}>
      <p className="font-sans text-[12px] text-text-secondary">{o.settingsHint}</p>
      <button type="button" onClick={() => useOnboarding.getState().restart()} className={`${quietButton} mt-3 py-1.5!`}>
        <Sparkles size={12} /> {o.restart}
      </button>
    </Card>
  )
}
