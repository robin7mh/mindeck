import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Shell integration, like VS Code's: the shell reports its folder (OSC 7) and
// where prompts, commands and their output begin and end (OSC 133 A/B/C/D).
// Nothing in the user's dotfiles changes — the script rides in on a start
// argument or an environment variable, and runs the user's own files first.

/** The shell's "a command finished" mark (OSC 133;D). */
export const COMMAND_END = '\x1b]133;D'

/** How a program is started in a PTY. */
export interface ShellLaunch {
  file: string
  args: string[]
  env?: Record<string, string>
}

type Kind = 'bash' | 'zsh' | 'fish' | 'pwsh'

/** Shell parameter expansions (`${…}`) inside the scripts' JS templates. */
const D = '$'

/** The integration a program can take, by its binary name. */
export function shellKind(file: string, platform: NodeJS.Platform = process.platform): Kind | undefined {
  const name = file.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '')
  if (name === 'pwsh' || name === 'powershell') return 'pwsh'
  // Git Bash & co. on Windows read POSIX paths differently: no script files there.
  if (platform === 'win32') return undefined
  return name === 'bash' || name === 'zsh' || name === 'fish' ? name : undefined
}

const BASH = String.raw`# Mindeck shell integration (bash). Loaded with --init-file instead of the
# user's startup files — so it reads them first, exactly as bash would have.
if [ -n "$MINDECK_SHELL_LOGIN" ]; then
  unset MINDECK_SHELL_LOGIN
  [ -r /etc/profile ] && . /etc/profile
  if [ -r ~/.bash_profile ]; then . ~/.bash_profile
  elif [ -r ~/.bash_login ]; then . ~/.bash_login
  elif [ -r ~/.profile ]; then . ~/.profile
  fi
else
  [ -r /etc/bash.bashrc ] && . /etc/bash.bashrc
  [ -r ~/.bashrc ] && . ~/.bashrc
fi

if [ -z "$__mindeck_loaded" ]; then
  __mindeck_loaded=1
  __mindeck_status=0
  __mindeck_running=
  __mindeck_prompted=

  # First in PROMPT_COMMAND: the command's status (handed on unchanged), the folder.
  __mindeck_precmd() {
    __mindeck_status=$?
    if [ -n "$__mindeck_running" ]; then
      printf '\e]133;D;%s\a' "$__mindeck_status"
      __mindeck_running=
    fi
    printf '\e]7;file://%s%s\a' "$HOSTNAME" "${D}{PWD//\%/%25}"
    return $__mindeck_status
  }
  # Last in PROMPT_COMMAND: mark the prompt the user's setup has just built.
  __mindeck_prompt() {
    case "$PS1" in *'133;B'*) ;; *) __mindeck_ps1=$PS1 ;; esac
    PS1='\[\e]133;A\a\]'"$__mindeck_ps1"'\[\e]133;B\a\]'
    __mindeck_prompted=1
    return $__mindeck_status
  }
  # The first command after a prompt is the user's — unless it is PROMPT_COMMAND
  # again (an empty line), whose other parts then aren't either.
  __mindeck_preexec() {
    [ -n "$__mindeck_prompted" ] || return 0
    __mindeck_prompted=
    case "$BASH_COMMAND" in __mindeck_precmd*) return 0 ;; esac
    __mindeck_running=1
    printf '\e]133;C\a'
  }

  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__mindeck_precmd "${D}{PROMPT_COMMAND[@]}" __mindeck_prompt)
  else
    PROMPT_COMMAND=$'__mindeck_precmd\n'"${D}{PROMPT_COMMAND:-}"$'\n__mindeck_prompt'
  fi
  # Someone else's DEBUG trap (bash-preexec, …) stays: then there are prompt marks only.
  [ -n "$(trap -p DEBUG)" ] || trap '__mindeck_preexec' DEBUG
fi
`

/** zsh reads its startup files from ZDOTDIR: ours run the user's from where they would have been. */
const zshForward = (file: string) => `# Mindeck shell integration (zsh): runs the user's own ${file}.
__mindeck_zdotdir=$ZDOTDIR
ZDOTDIR=\${MINDECK_ZDOTDIR:-$HOME}
[[ -f "$ZDOTDIR/${file}" ]] && . "$ZDOTDIR/${file}"
# their file may move ZDOTDIR: the next ones are read from there
MINDECK_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__mindeck_zdotdir
`

/** Once the startup files are read, nested shells see the user's own ZDOTDIR again. */
const ZSH_RESTORE = `if [[ "\${MINDECK_ZDOTDIR:-$HOME}" == "$HOME" ]]; then unset ZDOTDIR; else ZDOTDIR=$MINDECK_ZDOTDIR; fi
unset MINDECK_ZDOTDIR __mindeck_zdotdir
`

const ZSH_HOOKS = String.raw`
if [[ -z $__mindeck_loaded ]]; then
  __mindeck_loaded=1
  __mindeck_status=0
  __mindeck_running=
  # First precmd hook: the status of the user's command, before other hooks change $?.
  __mindeck_save() { __mindeck_status=$? }
  # Last precmd hook: report, then mark the prompt the user's theme has just built.
  __mindeck_precmd() {
    if [[ -n $__mindeck_running ]]; then
      print -n "\e]133;D;$__mindeck_status\a"
      __mindeck_running=
    fi
    print -n "\e]7;file://$HOST${D}{PWD//\%/%25}\a"
    [[ $PS1 == *'133;B'* ]] || __mindeck_ps1=$PS1
    PS1="%{"$'\e]133;A\a'"%}$__mindeck_ps1%{"$'\e]133;B\a'"%}"
  }
  __mindeck_preexec() {
    __mindeck_running=1
    print -n "\e]133;C\a"
  }
  precmd_functions=(__mindeck_save $precmd_functions __mindeck_precmd)
  preexec_functions+=(__mindeck_preexec)
fi
`

const FISH = String.raw`# Mindeck shell integration (fish), sourced by --init-command after the user's config.
if not set -q __mindeck_loaded
    set -g __mindeck_loaded 1
    function __mindeck_preexec --on-event fish_preexec
        printf '\e]133;C\a'
    end
    function __mindeck_postexec --on-event fish_postexec
        printf '\e]133;D;%s\a' $status
    end
    function __mindeck_cwd --on-event fish_prompt
        printf '\e]7;file://%s%s\a' $hostname (string replace -a % %25 -- $PWD)
    end
    if functions -q fish_prompt
        functions -c fish_prompt __mindeck_user_prompt
        function fish_prompt
            printf '\e]133;A\a'
            __mindeck_user_prompt
            printf '\e]133;B\a'
        end
    end
end
`

/**
 * PowerShell (pwsh and Windows PowerShell 5.1, which has no `e escape): wraps
 * the prompt, and PSReadLine's line reader for the start of a command. Passed
 * inline (-EncodedCommand), so no execution policy stands in the way.
 */
export const PWSH = String.raw`if (-not $global:__mindeckLoaded) {
  $global:__mindeckLoaded = $true
  $global:__mindeckRan = $false
  $global:__mindeckPrompt = $function:prompt
  function global:prompt {
    $ok = $?
    $code = if ($ok) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }
    $e = [char]27; $b = [char]7; $s = ''
    if ($global:__mindeckRan) { $s += "$e]133;D;$code$b"; $global:__mindeckRan = $false }
    $loc = $executionContext.SessionState.Path.CurrentLocation
    if ($loc.Provider.Name -eq 'FileSystem') {
      $s += "$e]7;file://$([Environment]::MachineName)/$($loc.ProviderPath.Replace('\', '/').Replace('%', '%25').TrimStart('/'))$b"
    }
    $s + "$e]133;A$b" + (& $global:__mindeckPrompt) + "$e]133;B$b"
  }
  if (Get-Command PSConsoleHostReadLine -ErrorAction SilentlyContinue) {
    $global:__mindeckReadLine = $function:PSConsoleHostReadLine
    function global:PSConsoleHostReadLine {
      $line = & $global:__mindeckReadLine
      if ($line -and $line.Trim()) { $global:__mindeckRan = $true; [Console]::Write("$([char]27)]133;C$([char]7)") }
      $line
    }
  }
}
`

/** The script files, by their path under the integration folder. */
export const SCRIPTS: Record<string, string> = {
  'mindeck.bash': BASH,
  'mindeck.fish': FISH,
  'zsh/.zshenv': zshForward('.zshenv'),
  'zsh/.zprofile': zshForward('.zprofile'),
  // An interactive shell that is not a login shell reads no .zlogin: it restores here.
  'zsh/.zshrc': `${zshForward('.zshrc')}${ZSH_HOOKS}[[ -o login ]] || {\n${ZSH_RESTORE}}\n`,
  'zsh/.zlogin': `${zshForward('.zlogin')}${ZSH_RESTORE}`
}

/** Writes the scripts (again — an update may have changed them). */
export async function writeScripts(dir: string): Promise<void> {
  for (const [file, text] of Object.entries(SCRIPTS)) {
    const path = join(dir, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
  }
}

/** Arguments a shell may already have and still take the integration (anything else: as given). */
const PLAIN = { posix: ['-l', '--login', '-i'], pwsh: ['-nologo', '-login', '-l'] }

const fishQuote = (s: string) => `'${s.replace(/[\\']/g, '\\$&')}'`

/**
 * The launch with integration, or undefined when this program can't take it
 * (not a supported shell, or started with arguments of its own, e.g. `-c`).
 * `dir` is where writeScripts put the files; `env` the environment it starts with.
 */
export function integrate(
  launch: ShellLaunch,
  dir: string,
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): ShellLaunch | undefined {
  const kind = shellKind(launch.file, platform)
  const { file, args } = launch
  if (kind === 'pwsh') {
    if (!args.every((a) => PLAIN.pwsh.includes(a.toLowerCase()))) return undefined
    const encoded = Buffer.from(PWSH, 'utf16le').toString('base64')
    return { file, args: [...args, '-NoExit', '-EncodedCommand', encoded] }
  }
  if (!kind || !args.every((a) => PLAIN.posix.includes(a))) return undefined
  const login = args.includes('-l') || args.includes('--login')
  if (kind === 'bash') {
    return { file, args: ['--init-file', join(dir, 'mindeck.bash'), '-i'], env: login ? { MINDECK_SHELL_LOGIN: '1' } : {} }
  }
  if (kind === 'zsh') return { file, args, env: { ZDOTDIR: join(dir, 'zsh'), MINDECK_ZDOTDIR: env.ZDOTDIR ?? '' } }
  return { file, args: [...args, '--init-command', `source ${fishQuote(join(dir, 'mindeck.fish'))}`] }
}

// --- the folder a shell reports (OSC 7) ---------------------------------------

const OSC7 = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g
const START = '\x1b]7;'

/** A `file://host/path` URL as a local absolute path, or undefined. */
export function fileUrlPath(url: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const match = /^file:\/\/[^/]*(\/.*)$/.exec(url)
  if (!match) return undefined
  let path = match[1]
  try {
    path = decodeURIComponent(path)
  } catch {
    /* not percent-encoded after all: as written */
  }
  if (platform === 'win32') {
    if (!/^\/[A-Za-z]:/.test(path)) return undefined
    return path.slice(1).replace(/\//g, '\\')
  }
  return path
}

/**
 * The last folder reported in `text` (output so far unscanned, carry first),
 * and the start of a report that the next chunk completes (`carry`).
 */
export function scanCwd(text: string, platform: NodeJS.Platform = process.platform): { cwd?: string; carry: string } {
  let cwd: string | undefined
  for (const m of text.matchAll(OSC7)) cwd = fileUrlPath(m[1], platform) ?? cwd
  const open = text.lastIndexOf(START)
  if (open >= 0 && !/\x07|\x1b\\/.test(text.slice(open + START.length))) {
    // A report never runs this long: whatever it was, drop it.
    return { cwd, carry: text.length - open > 4096 ? '' : text.slice(open) }
  }
  // The chunk may end inside the introducer itself.
  for (let n = START.length - 1; n > 0; n -= 1) {
    if (text.endsWith(START.slice(0, n))) return { cwd, carry: START.slice(0, n) }
  }
  return { cwd, carry: '' }
}
