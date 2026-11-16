import { useRef } from 'react'
import { useXterm, type XtermApi } from '@/features/terminal/useXterm'

/** useXterm as an agent session uses it: only the exit hook. */
export function SessionTerminalProbe({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null)
  useXterm(host, id, false, { onExit: () => undefined })
  return <div ref={host} />
}

/** The last api a probe got, to call after its view is gone. */
export let lastApi: XtermApi | undefined

export function ApiProbe({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null)
  lastApi = useXterm(host, id, false, { onExit: () => undefined }).api
  return <div ref={host} />
}
