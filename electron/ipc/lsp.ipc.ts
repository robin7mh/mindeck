import type { Router } from './router'
import type { LspService } from '../main/services/lsp/LspService'

/** Binds the lsp:* contract channels (the editor's TypeScript intelligence) to LspService. */
export function registerLspIpc(router: Router, service: LspService): void {
  router.register('lsp:open', ({ projectId, path, text }) => service.open(projectId, path, text))
  router.register('lsp:change', ({ projectId, path, text }) => service.change(projectId, path, text))
  router.register('lsp:close', ({ projectId, path }) => service.close(projectId, path))
  router.register('lsp:diagnostics', ({ projectId, paths }) => service.diagnostics(projectId, paths))
  router.register('lsp:hover', ({ projectId, path, line, offset }) => service.hover(projectId, path, line, offset))
  router.register('lsp:completions', ({ projectId, path, line, offset, trigger }) => service.completions(projectId, path, line, offset, trigger))
  router.register('lsp:completionDetails', ({ projectId, path, line, offset, name, source, data }) =>
    service.completionDetails(projectId, path, line, offset, name, source, data)
  )
  router.register('lsp:definition', ({ projectId, path, line, offset }) => service.definition(projectId, path, line, offset))
  router.register('lsp:references', ({ projectId, path, line, offset }) => service.references(projectId, path, line, offset))
  router.register('lsp:rename', ({ projectId, path, line, offset, newName }) => service.rename(projectId, path, line, offset, newName))
  router.register('lsp:signature', ({ projectId, path, line, offset }) => service.signature(projectId, path, line, offset))
  router.register('lsp:codeFixes', ({ projectId, path, range, errorCodes }) => service.codeFixes(projectId, path, range, errorCodes))
  router.register('lsp:symbols', ({ projectId, path }) => service.symbols(projectId, path))
}
