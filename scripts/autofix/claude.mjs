// Runs Claude Code headlessly for the auto-fix workflow and verifies what it produced.
// The launcher resolution mirrors scripts/pr-review/run-review.mjs.
//
// Environment:
//   ANTHROPIC_API_KEY        required
//   CLAUDE_CODE_PACKAGE_DIR  optional @anthropic-ai/claude-code package directory (workflow sets it)
//   CLAUDE_CLI               optional explicit launcher file
//   AUTOFIX_MODEL            default claude-opus-5-5
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { outPath, writeText } from './issues.mjs'

const MAX_BUFFER = 64 * 1024 * 1024

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|(^|_)PAT$/i
// Files the runner reads back after a step. Code written by Claude must not be able to find them,
// or it could set variables and PATH entries for later steps.
const RUNNER_FILES = /^GITHUB_(ENV|PATH|OUTPUT|STATE|STEP_SUMMARY)$/

/**
 * The environment for anything that can execute code written by Claude (Claude Code itself, pytest).
 * Tests are code, and bug text is untrusted, so no secret may be readable from there: every variable
 * that looks like a credential is dropped unless it is listed in `keep`.
 */
export function scrubbedEnv(keep = []) {
  const env = { CI: 'true' }
  for (const [name, value] of Object.entries(process.env)) {
    if (keep.includes(name) || (!SECRET_NAME.test(name) && !RUNNER_FILES.test(name))) env[name] = value
  }
  return env
}

export function git(args, { allowFail = false, env = scrubbedEnv() } = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, env })
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr}`)
  return r.stdout
}

/**
 * git commands that talk to the server (fetch, push, ls-remote). The checkout does not persist
 * credentials, so the token is supplied for this one command only, through the environment rather
 * than the command line or .git/config. Locally the user's own git credentials are used.
 */
export function gitRemote(args) {
  const env = scrubbedEnv()
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (token) {
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.extraheader'
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  }
  return git(args, { env })
}

/**
 * Runs a fixed command line through the shell. Never pass untrusted text.
 * The command may execute tests written by Claude, so it gets no secrets at all.
 */
export function sh(command) {
  const r = spawnSync(command, { encoding: 'utf8', shell: true, maxBuffer: MAX_BUFFER, env: scrubbedEnv() })
  return { status: r.status ?? 1, output: `${r.stdout || ''}${r.stderr || ''}` }
}

export function tail(text, chars = 4000) {
  const s = String(text || '')
  return s.length > chars ? `...\n${s.slice(-chars)}` : s
}

export function sha256(file) {
  return existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null
}

/** Stages everything and returns `git diff --numstat` of the working tree against `base`. */
export function stagedNumstat(base = 'HEAD') {
  git(['add', '-A'])
  return git(['diff', '--cached', '--numstat', base])
}

/** Stages everything and returns the change against `base` as a patch that `git apply` accepts. */
export function stagedPatch(base = 'HEAD') {
  git(['add', '-A'])
  return git(['diff', '--cached', '--binary', base])
}

/** Applies a patch file from the output folder to the index and working tree. */
export function applyPatch(name) {
  git(['apply', '--index', '--whitespace=nowarn', outPath(name)])
}

export function remoteBranchExists(branch) {
  return gitRemote(['ls-remote', '--heads', 'origin', branch]).trim() !== ''
}

/** Commits everything in the working tree as the automation identity and pushes it to `branch`. */
export function commitAndPush(branch, message) {
  const name = process.env.AUTOFIX_GIT_NAME || 'Claude Autofix'
  const email = process.env.AUTOFIX_GIT_EMAIL || 'claude-autofix@users.noreply.github.com'
  git(['add', '-A'])
  git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', `${message}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`])
  gitRemote(['push', 'origin', `HEAD:refs/heads/${branch}`])
  return git(['rev-parse', 'HEAD']).trim()
}

function launcherFromPackageDir(dir) {
  const candidates = [
    { file: join(dir, 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'), viaNode: false },
    { file: join(dir, 'cli.js'), viaNode: true },
    { file: join(dir, 'cli-wrapper.cjs'), viaNode: true },
  ]
  return candidates.find((c) => existsSync(c.file)) || null
}

function resolveLauncher() {
  if (process.env.CLAUDE_CLI) {
    return { file: process.env.CLAUDE_CLI, viaNode: /\.(c|m)?js$/i.test(process.env.CLAUDE_CLI) }
  }
  const dirs = []
  if (process.env.CLAUDE_CODE_PACKAGE_DIR) dirs.push(process.env.CLAUDE_CODE_PACKAGE_DIR)
  try {
    dirs.push(dirname(createRequire(join(process.cwd(), 'package.json')).resolve('@anthropic-ai/claude-code/package.json')))
  } catch {
    // not installed locally
  }
  const npm = spawnSync('npm root -g', { encoding: 'utf8', shell: true })
  if (npm.status === 0) dirs.push(join(npm.stdout.trim(), '@anthropic-ai', 'claude-code'))
  for (const dir of dirs) {
    const found = launcherFromPackageDir(dir)
    if (found) return found
  }
  return null
}

/**
 * One fresh, non-interactive Claude Code session with a JSON schema for the answer.
 * Returns { ok, structured, costUsd, turns, error }. Raw output is saved as <label>_stdout.json.
 */
export function runClaude({ label, prompt, schemaPath, allowedTools, budgetUsd, model = process.env.AUTOFIX_MODEL || 'claude-opus-5-5' }) {
  const schema = JSON.stringify(JSON.parse(readFileSync(schemaPath, 'utf8')))
  const args = [
    '-p',
    '--output-format', 'json',
    '--json-schema', schema,
    '--model', model,
    '--max-budget-usd', String(budgetUsd),
    '--allowedTools', allowedTools,
    '--disable-slash-commands',
    '--no-session-persistence',
  ]
  const launcher = resolveLauncher()
  const cmd = launcher ? (launcher.viaNode ? process.execPath : launcher.file) : 'claude'
  const cmdArgs = launcher?.viaNode ? [launcher.file, ...args] : args

  console.log(`[${label}] Claude Code (${launcher?.file || 'claude on PATH'}), model ${model}, budget $${Number(budgetUsd).toFixed(2)}`)
  writeText(`${label}_prompt.txt`, prompt)
  const started = Date.now()
  // Claude Code needs the API key itself; CLAUDE_CODE_SUBPROCESS_ENV_SCRUB keeps it out of the commands it runs.
  const env = { ...scrubbedEnv(['ANTHROPIC_API_KEY']), CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' }
  const run = spawnSync(cmd, cmdArgs, { input: prompt, encoding: 'utf8', maxBuffer: MAX_BUFFER, env })
  writeText(`${label}_stdout.json`, run.stdout || '')
  writeText(`${label}_stderr.txt`, run.stderr || '')

  if (run.error) return { ok: false, costUsd: 0, error: `Could not start Claude Code (${cmd}): ${run.error.message}` }

  let output = null
  try {
    output = JSON.parse(run.stdout)
  } catch {
    for (const line of (run.stdout || '').trim().split('\n').reverse()) {
      try {
        output = JSON.parse(line)
        break
      } catch {
        // keep looking
      }
    }
  }
  if (!output) return { ok: false, costUsd: 0, error: `Claude Code did not return JSON (exit ${run.status}): ${tail(run.stderr, 400)}` }

  const costUsd = Number(output.total_cost_usd) || 0
  console.log(`[${label}] finished in ${((Date.now() - started) / 1000).toFixed(0)}s, turns=${output.num_turns ?? '?'}, cost=$${costUsd.toFixed(4)}`)
  if (output.is_error) return { ok: false, costUsd, error: `Claude Code reported an error: ${String(output.result || output.error || output.subtype || '').slice(0, 400)}` }

  let structured = output.structured_output
  if (!structured && typeof output.result === 'string') {
    const m = output.result.match(/\{[\s\S]*\}/)
    try {
      structured = JSON.parse(m ? m[0] : output.result)
    } catch {
      structured = null
    }
  }
  if (!structured || typeof structured !== 'object') {
    return { ok: false, costUsd, error: `Claude output did not match the schema; see ${label}_stdout.json in the autofix artifact.` }
  }
  return { ok: true, structured, costUsd, turns: output.num_turns ?? null }
}

export const CHECKS = [
  ['lint', 'python -m ruff check .'],
  ['tests', 'python -m pytest'],
]

/** The same checks the build job runs. Returns the first failure with the end of its output. */
export function verifyAll(label) {
  const passed = []
  for (const [name, command] of CHECKS) {
    const r = sh(command)
    writeText(`${label}_${name}.log`, r.output)
    console.log(`[${label}] ${command}: ${r.status === 0 ? 'passed' : `FAILED (exit ${r.status})`}`)
    if (r.status !== 0) return { ok: false, passed, failed: name, command, output: tail(r.output) }
    passed.push(name)
  }
  return { ok: true, passed }
}

// pytest executes the tests Claude writes, so this allowlist is not a sandbox. The protection is that
// those processes hold no secrets (scrubbedEnv), that the job running them has no write token, and
// that only a patch limited to app/ and tests/ leaves the job.
const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash(python -m pytest)', 'Bash(python -m pytest *)', 'Bash(git diff *)', 'Bash(git status *)']

/** Tools for the reproduction session: write tests under tests/ and run them. No other edits or commands. */
export const REPRO_TOOLS = [...READ_TOOLS, 'Edit(tests/**)', 'Write(tests/**)'].join(' ')

/** Tools for sessions that fix code: edits limited to app/ and tests/, commands limited to the project's own checks. */
export const EDIT_TOOLS = [...READ_TOOLS, 'Edit(app/**)', 'Write(app/**)', 'Edit(tests/**)', 'Write(tests/**)', 'Bash(python -m ruff check *)'].join(' ')

export const FIX_SCHEMA = '.claude/autofix_fix_schema.json'

/**
 * Lets Claude change the code, then checks the result independently: allowed paths and size,
 * untouched reproduction tests, and the full lint/test run. A failed check is fed back for one
 * more attempt. `budget` is { total, spent } in USD and is updated in place.
 *
 * Returns { ok: true, fix, change, verification } or { ok: false, stage, reason, pushable }.
 * `pushable` says whether the partial work is safe to push for a person to continue.
 */
export function fixLoop({ label, promptFor, checkChange, base = 'HEAD', protectedHashes = {}, budget, maxAttempts = 2 }) {
  const fail = (stage, reason, pushable) => ({ ok: false, stage, reason, pushable })
  let feedback = ''
  let lastFailure = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = budget.total - budget.spent
    if (remaining < 0.25) return fail('budget', `The budget of $${budget.total} was used up before the fix was verified.`, attempt > 1)

    const run = runClaude({ label: `${label}${attempt}`, prompt: promptFor(feedback, attempt), schemaPath: FIX_SCHEMA, allowedTools: EDIT_TOOLS, budgetUsd: remaining })
    budget.spent += run.costUsd
    if (!run.ok) return fail('fix', run.error, false)

    const change = checkChange(stagedNumstat(base))
    if (!change.ok) return fail('guardrail', `The change was rejected: ${change.violations.join('; ')}.`, false)
    if (change.files.length === 0) return fail('fix', 'Claude did not change any file.', false)
    for (const [file, hash] of Object.entries(protectedHashes)) {
      if (sha256(file) !== hash) return fail('guardrail', `The reproduction test ${file} was modified while fixing; the fix cannot be trusted.`, false)
    }
    if (!run.structured.fixed) return fail('fix', `Claude could not complete the fix: ${run.structured.root_cause}`, true)

    const verification = verifyAll(`${label}${attempt}`)
    if (verification.ok) return { ok: true, fix: run.structured, change, verification, attempts: attempt }
    lastFailure = verification.failed
    feedback = `\`${verification.command}\` failed after your previous change. End of its output:\n\n${verification.output}`
  }
  return fail('verify', `The ${lastFailure} check still fails after ${maxAttempts} attempts.`, true)
}
