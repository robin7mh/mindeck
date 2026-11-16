import { useEffect, useState } from 'react'

/** Ticks once per second. Returns a live Date. Not `active` (off screen): it rests, and is on time again when back. */
export function useClock(active = true): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!active) return
    setNow(new Date())
    const id = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [active])
  return now
}
