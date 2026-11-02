import type { Labels } from '../../services/browser/labels'
import type { MenuEntry } from '../../services/browser/types'

/** The right-click facts of a page (Electron's ContextMenuParams, the fields Mindeck uses). */
export interface ContextParams {
  x: number
  y: number
  linkURL: string
  srcURL: string
  mediaType: string
  selectionText: string
  isEditable: boolean
  misspelledWord: string
  dictionarySuggestions: string[]
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean }
}

/** What the page's context menu does — the host fills these in. */
export interface ContextActions {
  openTab(url: string): void
  openPrivate(url: string): void
  /** Download `url`, asking where (Save … As). */
  saveAs(url: string): void
  /** Picture in picture for the video at that point. */
  pictureInPicture(x: number, y: number): void
  handoff(url: string): void
  copyText(text: string): void
  saveImage(url: string): void
  copyImage(x: number, y: number): void
  edit(action: 'cut' | 'copy' | 'paste' | 'selectAll'): void
  replaceMisspelling(word: string): void
  addToDictionary(word: string): void
  search(text: string): void
  back(): void
  forward(): void
  reload(): void
  canGoBack: boolean
  canGoForward: boolean
  sendToAgent(): void
  inspect(x: number, y: number): void
}

const isWeb = (url: string) => /^https?:\/\//i.test(url)

/** A page's right-click menu like Chrome's: spelling, link, image, text, editing — then agent and inspect. */
export function contextMenu(p: ContextParams, a: ContextActions, l: Labels, engine: string, app: string): MenuEntry[] {
  const groups: MenuEntry[][] = []
  if (p.misspelledWord) {
    groups.push([
      ...p.dictionarySuggestions.slice(0, 5).map((word): MenuEntry => ({ label: word, run: () => a.replaceMisspelling(word) })),
      { label: l.addToDictionary, run: () => a.addToDictionary(p.misspelledWord) }
    ])
  }
  if (p.linkURL) {
    groups.push([
      { label: l.openLinkInTab, enabled: isWeb(p.linkURL), run: () => a.openTab(p.linkURL) },
      { label: l.openLinkPrivate, enabled: isWeb(p.linkURL), run: () => a.openPrivate(p.linkURL) },
      { label: l.handoff(app), enabled: isWeb(p.linkURL), run: () => a.handoff(p.linkURL) },
      { label: l.saveLinkAs, enabled: isWeb(p.linkURL), run: () => a.saveAs(p.linkURL) },
      { label: l.copyLink, run: () => a.copyText(p.linkURL) }
    ])
  }
  if (p.mediaType === 'image' && p.srcURL) {
    groups.push([
      { label: l.openImageInTab, enabled: isWeb(p.srcURL), run: () => a.openTab(p.srcURL) },
      { label: l.saveImage, run: () => a.saveImage(p.srcURL) },
      { label: l.saveImageAs, run: () => a.saveAs(p.srcURL) },
      { label: l.copyImage, run: () => a.copyImage(p.x, p.y) },
      { label: l.copyImageAddress, run: () => a.copyText(p.srcURL) }
    ])
  }
  if ((p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL) {
    const video = p.mediaType === 'video'
    groups.push([
      ...(video ? [{ label: l.pictureInPicture, run: () => a.pictureInPicture(p.x, p.y) }] : []),
      { label: video ? l.saveVideoAs : l.saveAudioAs, enabled: isWeb(p.srcURL), run: () => a.saveAs(p.srcURL) }
    ])
  }
  const text = p.selectionText.trim()
  if (p.isEditable) {
    groups.push([
      { label: l.cut, enabled: p.editFlags.canCut, run: () => a.edit('cut') },
      { label: l.copy, enabled: p.editFlags.canCopy, run: () => a.edit('copy') },
      { label: l.paste, enabled: p.editFlags.canPaste, run: () => a.edit('paste') },
      { label: l.selectAll, enabled: p.editFlags.canSelectAll, run: () => a.edit('selectAll') }
    ])
  } else if (text) {
    groups.push([
      { label: l.copy, run: () => a.edit('copy') },
      { label: l.searchFor(engine, text), run: () => a.search(text) }
    ])
  }
  if (!p.linkURL && !text && !p.isEditable && p.mediaType !== 'image') {
    groups.push([
      { label: l.back, enabled: a.canGoBack, run: a.back },
      { label: l.forward, enabled: a.canGoForward, run: a.forward },
      { label: l.reload, run: a.reload }
    ])
  }
  groups.push([{ label: l.sendToAgent, run: a.sendToAgent }])
  groups.push([{ label: l.inspect, run: () => a.inspect(p.x, p.y) }])
  return groups.flatMap((g, i) => (i ? [{ separator: true } as const, ...g] : g))
}
