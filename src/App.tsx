import { AppShell } from '@/components/shell/AppShell'
import { SessionGate } from '@/features/session/components/SessionGate'
import { LicenseGate } from '@/features/cloud/components/LicenseGate'
import { Onboarding } from '@/features/onboarding/components/Onboarding'

/** Reach a core (pairing in a browser), then a licensed Mindeck account, then the app (the setup over it on the first start). */
export default function App() {
  return (
    <SessionGate>
      <LicenseGate>
        <AppShell />
        <Onboarding />
      </LicenseGate>
    </SessionGate>
  )
}
