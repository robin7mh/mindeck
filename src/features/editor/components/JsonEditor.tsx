import { useEffect, useRef } from 'react'
import { applyMonacoTheme, monaco, THEME } from '../monaco/setup'

let seq = 0

/**
 * One JSON text in Monaco (a MongoDB document, a pipeline …): JSON
 * highlighting and validation, ⌘S calls onSave. Loaded lazily like the editor.
 */
export default function JsonEditor({ value, onChange, onSave }: { value: string; onChange: (text: string) => void; onSave?: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef({ onChange, onSave })
  latest.current = { onChange, onSave }

  useEffect(() => {
    applyMonacoTheme()
    const model = monaco.editor.createModel(value, 'json', monaco.Uri.parse(`inmemory://json/${++seq}.json`))
    const editor = monaco.editor.create(host.current!, {
      model,
      theme: THEME,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 12.5,
      tabSize: 2
    })
    const sub = model.onDidChangeContent(() => latest.current.onChange(model.getValue()))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => latest.current.onSave?.())
    editor.focus()
    return () => {
      sub.dispose()
      editor.dispose()
      model.dispose()
    }
    // The text is the editor's from here on; a new document remounts it (key).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [])

  return <div ref={host} className="h-full w-full" />
}
