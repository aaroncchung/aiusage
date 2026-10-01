import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AIUSAGE_DIR } from '../config.js'

/** The isolated Git environment could not be prepared; no Git command was run. */
export class GitIsolationError extends Error {}

/**
 * Git for Windows 2.56 rejects the null device as a config path: with
 * `GIT_CONFIG_GLOBAL=NUL` every command exits 128 with "unable to access 'NUL'".
 * Windows therefore isolates global config with an empty regular file that
 * aiusage owns. It is re-checked on every call and truncated if anything wrote to it.
 */
export function emptyGitConfigPath(dir = AIUSAGE_DIR): string {
  const path = join(dir, 'git-empty-config')
  let stats
  try {
    mkdirSync(dir, { recursive: true })
    try {
      writeFileSync(path, '', { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== 'EEXIST') throw error
    }
    stats = lstatSync(path)
    if (stats.isFile() && stats.size > 0) writeFileSync(path, '', { mode: 0o600 })
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown error'
    throw new GitIsolationError(`Cannot prepare the empty Git config file in the aiusage directory (${code}).`)
  }
  if (!stats.isFile()) throw new GitIsolationError('The empty Git config file in the aiusage directory is not a regular file.')
  return path
}

/** Git's helper protocol carries credentials over a pipe, never argv or remote URLs.
 * The helper is ephemeral (-c), answers only for this exact GitHub repository, and
 * ignores store/erase so another credential helper cannot persist the token.
 */
export function gitCredentialOptions(repo: string, token?: string) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key) || /^(SSH_ASKPASS|AIUSAGE_GITHUB_TOKEN|AIUSAGE_GIT_CREDENTIAL)$/i.test(key)) delete env[key]
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? emptyGitConfigPath() : '/dev/null'
  // core.hooksPath=/dev/null still disables hooks on Git for Windows 2.56: it is not resolved
  // against the current drive root, so a hook planted under `<drive>:\dev\null\` does not run.
  const args = ['-c', 'credential.helper=', '-c', 'credential.useHttpPath=true',
    '-c', 'http.extraHeader=', '-c', 'http.followRedirects=false', '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=AIUsage', '-c', 'user.email=aiusage@localhost', '-c', 'commit.gpgSign=false']
  if (token) {
    env.AIUSAGE_GIT_CREDENTIAL = token
    // This source contains no secrets; shell single quotes prevent expansion.
    const source = `if(process.argv[1]==='get'){let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const p=Object.fromEntries(s.trim().split('\\n').map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)]}));if(p.protocol==='https'&&p.host==='github.com'&&p.path===${JSON.stringify(`${repo}.git`)})process.stdout.write('username=x-access-token\\npassword='+process.env.AIUSAGE_GIT_CREDENTIAL+'\\n\\n')})}`
    const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`
    args.push('-c', `credential.helper=!${quote(process.execPath.replace(/\\/g, '/'))} -e ${quote(source)}`)
  }
  return { args, env }
}

const GITHUB_TOKEN = /\b(?:gh[opsuhr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)/g

/**
 * One line describing why a Git child process failed: the first `fatal:` (else
 * `error:`) line of stderr. Server-relayed text and anything about the credential
 * helper (whose configuration embeds the helper source) is reduced to a fixed
 * phrase; the token, GitHub token shapes and URL userinfo are redacted.
 */
export function gitFailureSummary(error: unknown, token?: string): string | undefined {
  const failure = error as { code?: unknown; killed?: unknown; stderr?: unknown } | null
  if (failure?.code === 'ENOENT') return 'git was not found on PATH'
  if (failure?.killed) return 'git timed out'
  if (typeof failure?.stderr !== 'string') return undefined
  const lines = failure.stderr.split(/\r?\n/)
  const line = lines.find(l => l.startsWith('fatal: ')) ?? lines.find(l => l.startsWith('error: '))
  if (!line) return undefined
  const level = line.slice(0, line.indexOf(':'))
  if (/^fatal: remote error/i.test(line)) return 'fatal: remote error'
  if (/credential|AIUSAGE_GIT_CREDENTIAL|process\.(argv|stdin|env)/i.test(line)) return `${level}: credential helper failed`
  let summary = token ? line.split(token).join('[redacted]') : line
  summary = summary
    .replace(GITHUB_TOKEN, '[redacted]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@']*@/gi, '$1')
    .replace(/[\u0000-\u001f\u007f]/g, '')
  return summary.length > 200 ? `${summary.slice(0, 197)}...` : summary
}
