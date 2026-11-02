#!/usr/bin/env node
// A stand-in for the Claude Code CLI in end-to-end tests (MINDECK_CLAUDE_BIN):
// it reads the flags Mindeck passes, talks back through the real hooks, asks
// for one approval and writes a file — without any model or account. A prompt
// with `@` mentions is answered with what it found there (files, images).
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('9.9.9 (Claude Code)')
  process.exit(0)
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' }))
  process.exit(0)
}

const flag = (name) => args[args.indexOf(name) + 1]
// --settings: a file (it holds the session's token), or inline JSON as older Mindecks passed it.
const rawSettings = flag('--settings')
const settings = JSON.parse(rawSettings.trimStart().startsWith('{') ? rawSettings : readFileSync(rawSettings, 'utf8'))
const http = settings.hooks.Stop[0].hooks[0]
const sessionId = flag('--session-id') ?? flag('--resume')
const hook = async (event, extra = {}) => {
  const res = await fetch(http.url, {
    method: 'POST',
    headers: { ...http.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name: event, session_id: sessionId, cwd: process.cwd(), ...extra })
  })
  return res.status === 200 ? res.json() : undefined
}

/** What the `@` mentions point at: each file with its size, images by their kind. */
function mentioned(prompt) {
  const paths = [...prompt.matchAll(/(?:^|\s)@(?:"([^"]+)"|(\S+))/g)].map((m) => m[1] ?? m[2])
  return paths.map((path) => {
    const abs = isAbsolute(path) ? path : join(process.cwd(), path)
    try {
      if (/\.(png|jpe?g|gif|webp)$/i.test(path)) {
        const png = readFileSync(abs).subarray(1, 4).toString() === 'PNG'
        return `an image (${png ? 'PNG' : 'unknown'})`
      }
      return `${basename(path)} (${statSync(abs).size} bytes)`
    } catch {
      return `${path} (missing)`
    }
  })
}

async function turn(prompt) {
  await hook('UserPromptSubmit', { prompt })
  const seen = mentioned(prompt)
  if (seen.length) return hook('Stop', { last_assistant_message: `Read ${seen.join(' and ')}` })
  const input = { command: 'echo written by the fake agent > fake-output.txt' }
  await hook('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: 'tool-1' })
  const answer = await hook('PermissionRequest', { tool_name: 'Bash', tool_input: input, tool_use_id: 'tool-1' })
  if (answer?.hookSpecificOutput?.decision?.behavior === 'allow') {
    writeFileSync(join(process.cwd(), 'fake-output.txt'), 'written by the fake agent\n')
    await hook('PostToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: 'tool-1', tool_response: { stdout: '' } })
    await hook('Stop', { last_assistant_message: 'Done: wrote fake-output.txt' })
  } else {
    await hook('Stop', { last_assistant_message: 'Okay, I left it.' })
  }
}

// SessionStart goes through the relay (a command hook) in the real CLI.
await fetch(process.env.MINDECK_HOOK_URL, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.MINDECK_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: sessionId })
})
console.log('fake claude ready')

const prompt = args.includes('--') ? args[args.indexOf('--') + 1] : undefined
if (prompt) await turn(prompt)
// Typed input: a prompt ends at Enter — line breaks inside a bracketed paste are part of it.
// Slash commands (`/model sonnet`) are the CLI's own: no turn.
let line = ''
let pasting = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  for (const part of chunk.split(/(\x1b\[20[01]~)/)) {
    if (part === '\x1b[200~') pasting = true
    else if (part === '\x1b[201~') pasting = false
    else if (pasting) line += part
    else {
      for (const ch of part) {
        if (ch !== '\r' && ch !== '\n') line += ch
        else {
          const text = line.trim()
          line = ''
          if (text && !text.startsWith('/')) void turn(text)
        }
      }
    }
  }
})
