// Monaco's own services, beyond its public API — just what symbols.ts uses
// (the command behind ⇧⌘O, so the outline gets every language's symbols).

declare module 'monaco-editor/editor/standalone/browser/standaloneServices.js' {
  export const StandaloneServices: { get<T>(id: unknown): T }
}

declare module 'monaco-editor/platform/commands/common/commands.js' {
  export const ICommandService: unknown
}
