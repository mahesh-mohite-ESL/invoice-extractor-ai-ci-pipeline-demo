// Step 2: compute the PR diff and run Claude Code headlessly with a JSON schema for the output.
//
// Environment:
//   ANTHROPIC_API_KEY        required
//   CLAUDE_CODE_PACKAGE_DIR  optional @anthropic-ai/claude-code package directory (workflow sets it)
//   CLAUDE_CLI               optional explicit launcher file; otherwise auto-detected, falling back to `claude` on PATH
//   CLAUDE_MODEL             default claude-sonnet-5-5
//   CLAUDE_MAX_BUDGET_USD    default 2
//   REVIEW_BASE_BRANCH       base branch when not running in a PR run (default main)
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { ensureOutDir, logIssue, outPath, prContext, writeJson, writeText } from './github.mjs'

const SCHEMA_PATH = '.claude/review_schema.json'
const MAX_INLINE_DIFF_CHARS = 120_000

if (!process.env.ANTHROPIC_API_KEY) {
  logIssue('error', 'ANTHROPIC_API_KEY is not set. Add it as a repository secret (Settings > Secrets and variables > Actions).')
  process.exit(1)
}

const ctx = prContext()
const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5'
const maxBudget = process.env.CLAUDE_MAX_BUDGET_USD || '2'
const baseBranch = ctx?.targetBranch || process.env.REVIEW_BASE_BRANCH || 'main'

function git(args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr}`)
  return r.status === 0 ? r.stdout : ''
}

ensureOutDir()

// --- 1. Diff of this PR against the merge-base with the target branch -------------------------
// The workflow checks out the PR head with full history, so origin/<base> normally exists already.
if (!git(['rev-parse', '--verify', '--quiet', `origin/${baseBranch}`], { allowFail: true })) {
  git(['fetch', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`])
}
const mergeBase = git(['merge-base', `origin/${baseBranch}`, 'HEAD']).trim()
const changedFiles = git(['diff', '--name-only', mergeBase, 'HEAD']).trim().split('\n').filter(Boolean)
const diff = git(['diff', mergeBase, 'HEAD', '--', '.', ':(exclude)samples/*.pdf'])
writeText('pr.diff', diff)
writeText('changed_files.txt', changedFiles.join('\n'))
console.log(`Diff against ${baseBranch} (${mergeBase.slice(0, 8)}): ${changedFiles.length} file(s), ${diff.length} chars`)

if (changedFiles.length === 0) {
  writeJson('findings.json', { summary: 'No changes to review.', verdict: 'approve', findings: [] })
  console.log('Nothing to review.')
  process.exit(0)
}

// --- 2. Build the prompt ------------------------------------------------------------------------
const prior = existsSync(outPath('prior_findings.txt')) ? readFileSync(outPath('prior_findings.txt'), 'utf8').trim() : ''
const inlineDiff = diff.length <= MAX_INLINE_DIFF_CHARS

const prompt = [
  `You are the automated reviewer for pull request${ctx ? ` #${ctx.prId}` : ''} targeting \`${baseBranch}\` in this repository.`,
  'Follow the "PR review guidelines" section of CLAUDE.md exactly.',
  '',
  `Changed files (${changedFiles.length}):`,
  ...changedFiles.map((f) => `- ${f}`),
  '',
  inlineDiff
    ? 'The unified diff of the pull request is below. You may also read any file in the repository for context.'
    : `The unified diff is large; read it from ${outPath('pr.diff')} (use Read with offset/limit). You may also read any file in the repository for context.`,
  '',
  prior
    ? `Findings already posted on this PR by a previous review run. Do NOT report these again unless the latest changes made them worse:\n${prior}`
    : 'No findings have been posted on this PR yet.',
  '',
  'Produce the review as structured output matching the provided JSON schema. Every finding needs a repository-relative file path (forward slashes) and a line number in the new version of the file.',
  '',
  inlineDiff ? '```diff\n' + diff + '\n```' : '',
].join('\n')

writeText('prompt.txt', prompt)

// --- 3. Run Claude Code headlessly --------------------------------------------------------------
const schema = JSON.stringify(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')))
const args = [
  '-p',
  '--output-format', 'json',
  '--json-schema', schema,
  '--model', model,
  '--max-budget-usd', String(maxBudget),
  '--allowedTools', 'Read Grep Glob Bash(git diff *) Bash(git log *) Bash(git show *)',
  '--disable-slash-commands',
  '--no-session-persistence',
]

/**
 * Locates the Claude Code launcher without going through a shell (so the JSON schema argument survives).
 *   CLAUDE_CLI               explicit file: a native binary, or a .js/.cjs entry run with node
 *   CLAUDE_CODE_PACKAGE_DIR  explicit @anthropic-ai/claude-code package directory
 *   otherwise                local node_modules, then the global npm root, then `claude` on PATH
 * Newer package versions ship bin/claude(.exe); older ones ship cli.js.
 */
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
    const pkg = createRequire(join(process.cwd(), 'package.json')).resolve('@anthropic-ai/claude-code/package.json')
    dirs.push(dirname(pkg))
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

const launcher = resolveLauncher()
const cmd = launcher ? (launcher.viaNode ? process.execPath : launcher.file) : 'claude'
const cmdArgs = launcher?.viaNode ? [launcher.file, ...args] : args
console.log(`Claude Code launcher: ${launcher?.file || 'claude (on PATH)'}`)

// The review only reads the repository; it gets the API key but no GitHub token.
const env = { ...process.env, CI: 'true' }
delete env.GH_TOKEN
delete env.GITHUB_TOKEN

console.log(`Running Claude Code review with model ${model} (budget $${maxBudget})...`)
const started = Date.now()
const run = spawnSync(cmd, cmdArgs, { input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env })

writeText('claude_stdout.json', run.stdout || '')
writeText('claude_stderr.txt', run.stderr || '')

if (run.error) {
  logIssue('error', `Could not start Claude Code (${cmd}): ${run.error.message}. Set CLAUDE_CODE_PACKAGE_DIR or CLAUDE_CLI, or put claude on PATH.`)
  process.exit(1)
}

// --- 4. Parse output ----------------------------------------------------------------------------
let output = null
try {
  output = JSON.parse(run.stdout)
} catch {
  const lines = (run.stdout || '').trim().split('\n').reverse()
  for (const line of lines) {
    try {
      output = JSON.parse(line)
      break
    } catch {
      // keep looking
    }
  }
}

if (!output) {
  logIssue('error', `Claude Code did not return JSON (exit ${run.status}). stderr: ${(run.stderr || '').slice(0, 500)}`)
  process.exit(1)
}

console.log(`Claude finished in ${((Date.now() - started) / 1000).toFixed(0)}s, turns=${output.num_turns ?? '?'}, cost=$${(Number(output.total_cost_usd) || 0).toFixed(4)}`)

if (output.is_error) {
  logIssue('error', `Claude Code reported an error: ${String(output.result || output.error || '').slice(0, 500)}`)
  process.exit(1)
}

let review = output.structured_output
if (!review && typeof output.result === 'string') {
  try {
    review = JSON.parse(output.result)
  } catch {
    const m = output.result.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        review = JSON.parse(m[0])
      } catch {
        review = null
      }
    }
  }
}

if (!review || !Array.isArray(review.findings)) {
  logIssue('error', 'Claude output did not match the review schema. See claude_stdout.json in the claude-review artifact.')
  process.exit(1)
}

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
review.findings = review.findings.map((f) => ({
  severity: SEVERITIES.includes(String(f.severity).toLowerCase()) ? String(f.severity).toLowerCase() : 'info',
  category: String(f.category || 'maintainability'),
  file: String(f.file || '').replaceAll('\\', '/').replace(/^\.?\//, ''),
  line: Number.isInteger(f.line) && f.line > 0 ? f.line : 0,
  title: String(f.title || '').trim(),
  description: String(f.description || '').trim(),
  suggestion: String(f.suggestion || '').trim(),
}))
review.meta = { model, prId: ctx?.prId ?? null, baseBranch, mergeBase, cost_usd: output.total_cost_usd ?? null, turns: output.num_turns ?? null }

writeJson('findings.json', review)
console.log(`Review verdict: ${review.verdict}. ${review.findings.length} finding(s).`)
for (const f of review.findings) console.log(`  [${f.severity}] ${f.file}:${f.line} ${f.title}`)
