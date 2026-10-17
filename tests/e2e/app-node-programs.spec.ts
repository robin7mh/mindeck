import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

/** A stand-in ESLint (flat-config API): `var` is a problem. */
const ESLINT = `class ESLint {
  async isPathIgnored() { return false }
  async lintText(text) { return [{ messages: text.includes('var ') ? [{ line: 1, column: 1, message: 'Unexpected var', ruleId: 'no-var', severity: 2 }] : [] }] }
}
module.exports = { ESLint, loadESLint: async () => ESLint }
`

// Mindeck's binary never runs as Node (the RunAsNode fuse is off in releases): tsserver and the
// ESLint / Prettier worker run in Electron utility processes. MINDECK_E2E_ELECTRON runs this against
// an Electron with that fuse flipped, as a release has it.
test('tsserver and the lint worker run in utility processes: diagnostics and ESLint’s problems arrive', async ({ app, page, home }) => {
  const root = join(home, 'typed')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'eslint'), { recursive: true })
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }))
  writeFileSync(join(root, 'eslint.config.js'), 'module.exports = []\n')
  writeFileSync(join(root, 'node_modules', 'eslint', 'index.js'), ESLINT)
  const text = 'var n: number = "one"\n'
  writeFileSync(join(root, 'src', 'a.ts'), text)

  type Reply<T> = { ok: boolean; data: T }
  const invoke = <T>(channel: string, request: unknown) =>
    page.evaluate(([c, r]) => (window.mindeck!.invoke as (c: string, r: unknown) => Promise<unknown>)(c, r), [channel, request] as const) as Promise<Reply<T>>
  const project = await invoke<{ id: string }>('projects:add', { path: root })
  expect(project.ok).toBe(true)
  // The project's own tools run only once it is trusted.
  expect((await invoke('projects:trust', { id: project.data.id, trusted: true })).ok).toBe(true)

  expect((await invoke('lsp:open', { projectId: project.data.id, path: 'src/a.ts', text })).data).toMatchObject({ available: true })
  const diagnostics = await invoke<Record<string, { message: string }[]>>('lsp:diagnostics', { projectId: project.data.id, paths: ['src/a.ts'] })
  expect(JSON.stringify(diagnostics.data)).toContain("Type 'string' is not assignable to type 'number'")

  const lint = await invoke<{ available: boolean; diagnostics: { message: string }[] }>('lint:file', { projectId: project.data.id, path: 'src/a.ts', text })
  expect(lint.data).toMatchObject({ available: true, diagnostics: [{ message: 'Unexpected var' }] })

  // Utility processes carry their name (lib/nodeProcess.ts) — not Mindeck's binary started as Node.
  const utility = await app.evaluate(({ app }) => app.getAppMetrics().filter((m) => m.serviceName === 'node.mojom.NodeService').map((m) => m.name))
  expect(utility).toEqual(expect.arrayContaining(['TypeScript', 'ESLint / Prettier']))
})
