// GitHub helpers for the bug auto-fix workflow: issues, labels and pull requests.
// Plain Node (>=20), no dependencies. Pure helpers are exported so they can be unit-tested with `node --test`.
//
// Context comes from the workflow (GITHUB_REPOSITORY, GH_TOKEN) or, for local runs, from the same variables set by hand.
// AUTOFIX_DRY_RUN=1 turns every write into a log line so the scripts can be exercised safely.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const OUT_DIR = 'autofix-output'
export const MARKER = 'claude-autofix'
export const REVIEW_MARKER = 'claude-review'
export const REVIEW_STATUS_CONTEXT = 'claude/review'
export const DRY_RUN = process.env.AUTOFIX_DRY_RUN === '1'

export const LABELS = {
  optIn: 'claude-autofix',
  inProgress: 'claude-in-progress',
  prOpen: 'claude-pr-open',
  needsHuman: 'claude-needs-human',
}
export const FIXUP_LABEL = 'claude-fixup-done'

// --- Output folder --------------------------------------------------------------------------------

export function outPath(name) {
  return join(OUT_DIR, name)
}

function ensureOutDir() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
}

export function readJson(name, fallback = null) {
  const p = outPath(name)
  if (!existsSync(p)) return fallback
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(name, value) {
  ensureOutDir()
  writeFileSync(outPath(name), JSON.stringify(value, null, 2))
}

export function writeText(name, value) {
  ensureOutDir()
  writeFileSync(outPath(name), value)
}

// --- Workflow logging -----------------------------------------------------------------------------

export function logIssue(type, message) {
  const text = String(message).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  console.log(`::${type === 'error' ? 'error' : 'warning'}::${text}`)
}

/** Sets a step output (read by the workflow as steps.<id>.outputs.<name>). */
export function setOutput(name, value) {
  const line = `${name}=${String(value).replace(/\r?\n/g, ' ')}`
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`)
  console.log(`[output] ${line}`)
}

// --- Pure helpers ---------------------------------------------------------------------------------

export function labelNames(item) {
  return (item?.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean)
}

export function hasLabel(item, label) {
  return labelNames(item).some((l) => l.toLowerCase() === label.toLowerCase())
}

/** Open issues (not pull requests) that opted in and are not being worked on or waiting for a person. */
export function isEligible(issue) {
  return (
    issue.state === 'open' &&
    !issue.pull_request &&
    hasLabel(issue, LABELS.optIn) &&
    !hasLabel(issue, LABELS.inProgress) &&
    !hasLabel(issue, LABELS.prOpen) &&
    !hasLabel(issue, LABELS.needsHuman)
  )
}

/** Files Claude may add tests in. Only simple paths under tests/, so the names are safe on a command line. */
export function isTestFile(file) {
  return /^tests\/[\w./-]+$/.test(file) && !file.includes('..')
}

/** Test modules pytest should run to prove the reproduction. */
export function isPytestModule(file) {
  return isTestFile(file) && /(^|\/)test_[\w-]+\.py$/.test(file)
}

/**
 * Guardrail for AI-written changes: only files under the allowed prefixes may change, the change
 * must stay small, and files under tests/ may only gain lines (no edited or deleted tests or fixtures).
 * `numstat` is the output of `git diff --numstat`.
 */
export function checkChange(numstat, { allowed = ['app/', 'tests/'], maxLines = 300, protectTests = true } = {}) {
  const violations = []
  const files = []
  let lines = 0
  for (const row of String(numstat || '').split('\n').filter(Boolean)) {
    const [added, removed, ...rest] = row.split('\t')
    const file = rest.join('\t').replaceAll('\\', '/')
    files.push(file)
    if (added === '-' || removed === '-') violations.push(`${file}: binary files are not allowed`)
    else lines += Number(added) + Number(removed)
    // Tests may only grow: a removed or rewritten line could hide a regression, so a person must decide.
    if (protectTests && file.startsWith('tests/') && removed !== '0') {
      violations.push(`${file}: existing test lines were removed or changed`)
    }
    if (file.includes('=>') || file.includes('..') || !allowed.some((prefix) => file.startsWith(prefix))) {
      violations.push(`${file}: outside the allowed paths (${allowed.join(', ')})`)
    }
  }
  if (lines > maxLines) violations.push(`change is ${lines} lines, above the limit of ${maxLines}`)
  return { ok: violations.length === 0, violations, files, lines }
}

/** Names of the tests that failed with an assertion or exception, from a pytest JUnit XML report. */
export function failedTests(xml) {
  const failed = []
  for (const m of String(xml || '').matchAll(/<testcase\b((?:[^>"]|"[^"]*")*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    if (!/<failure\b/.test(m[2] || '')) continue
    const attr = (name) => m[1].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] || ''
    failed.push(`${attr('classname')}::${attr('name')}`)
  }
  return failed
}

export function limitsFromEnv() {
  return {
    allowed: (process.env.AUTOFIX_ALLOWED_PATHS || 'app/,tests/').split(',').map((p) => p.trim()).filter(Boolean),
    maxLines: Number(process.env.AUTOFIX_MAX_CHANGED_LINES || 300),
  }
}

export function bugBranch(issueNumber, suffix = '') {
  return `autofix/issue-${issueNumber}${suffix ? `-${suffix}` : ''}`
}

/** Extracts the issue number from an autofix branch name, or null. */
export function bugIdFromBranch(ref) {
  const m = String(ref || '').match(/autofix\/issue-(\d+)/)
  return m ? Number(m[1]) : null
}

/** Findings posted by the Claude PR review (scripts/pr-review/post-findings.mjs), from the PR's comments. */
export function openReviewFindings(comments) {
  const re = new RegExp(`<!--\\s*${REVIEW_MARKER}:finding\\s+(\\{.*?\\})\\s*-->`, 's')
  const findings = []
  for (const comment of comments) {
    const match = (comment.body || '').match(re)
    if (!match) continue
    try {
      findings.push({ ...JSON.parse(match[1]), commentId: comment.id, body: comment.body.replace(re, '').trim() })
    } catch {
      // ignore malformed markers
    }
  }
  return findings
}

/**
 * Decides what to do with an auto-fix PR.
 *   reviewState       state of the "claude/review" commit status on the PR head (null = not reviewed yet)
 *   changesRequested  a person requested changes
 *
 *   'wait'    no failed review of the current head commit
 *   'human'   a person requested changes or the PR was already handed over
 *   'fixup'   the review blocks and no automated fix-up was tried yet
 *   'giveup'  the review still blocks after the automated fix-up
 */
export function reviewAction({ labels = [], changesRequested = false, reviewState = null }) {
  if (labels.includes(LABELS.needsHuman) || changesRequested) return 'human'
  if (reviewState !== 'failure') return 'wait'
  return labels.includes(FIXUP_LABEL) ? 'giveup' : 'fixup'
}

/** True when the branch rules (GET /rules/branches/{branch}) require at least one approving review. */
export function requiresApproval(rules) {
  return (rules || []).some((rule) => rule.type === 'pull_request' && rule.parameters?.required_approving_review_count >= 1)
}

/** True when the latest review of at least one person is "changes requested". */
export function hasChangesRequested(reviews) {
  const latest = new Map()
  for (const review of reviews || []) {
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED' || review.state === 'DISMISSED') latest.set(review.user?.login, review.state)
  }
  return [...latest.values()].includes('CHANGES_REQUESTED')
}

// --- REST -----------------------------------------------------------------------------------------

export function context() {
  const env = process.env
  const repo = env.GITHUB_REPOSITORY || ''
  const token = env.GH_TOKEN || env.GITHUB_TOKEN || ''
  const missing = Object.entries({ GITHUB_REPOSITORY: repo, GH_TOKEN: token }).filter(([, v]) => !v).map(([k]) => k)
  if (missing.length > 0) {
    throw new Error(`GitHub context is incomplete (${missing.join(', ')}). In the workflow map GH_TOKEN in the step env; locally set GITHUB_REPOSITORY=owner/repo and GH_TOKEN.`)
  }
  const server = env.GITHUB_SERVER_URL || 'https://github.com'
  const apiRoot = env.GITHUB_API_URL || 'https://api.github.com'
  return {
    repo,
    token,
    apiRoot,
    api: `${apiRoot}/repos/${repo}`,
    graphql: env.GITHUB_GRAPHQL_URL || `${apiRoot}/graphql`,
    web: `${server}/${repo}`,
    buildUrl: env.GITHUB_RUN_ID ? `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : '',
  }
}

async function request(ctx, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'claude-autofix',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!res.ok) {
    const err = new Error(`GitHub ${method} ${url.replace(ctx.apiRoot, '')} failed: ${res.status} ${res.statusText} ${text.slice(0, 400)}`)
    err.status = res.status
    throw err
  }
  return json
}

/** Calls the GitHub REST API; `path` is relative to /repos/{owner}/{repo}. Writes are skipped in dry-run mode. */
export function api(ctx, method, path, body) {
  if (DRY_RUN && method !== 'GET') {
    console.log(`[dry-run] ${method} ${path}`)
    return Promise.resolve({ dryRun: true })
  }
  return request(ctx, method, `${ctx.api}${path}`, body)
}

async function listAll(ctx, path) {
  const items = []
  for (let page = 1; page <= 10; page++) {
    const batch = await api(ctx, 'GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    items.push(...(batch || []))
    if (!batch || batch.length < 100) break
  }
  return items
}

// --- Issues ---------------------------------------------------------------------------------------

export function getIssue(ctx, number) {
  return api(ctx, 'GET', `/issues/${number}`)
}

/** Eligible issues, oldest first. */
export async function findEligibleIssues(ctx) {
  const issues = await listAll(ctx, `/issues?state=open&labels=${encodeURIComponent(LABELS.optIn)}&sort=created&direction=asc`)
  return issues.filter(isEligible)
}

/** How many issues the automation has already finished (PR opened or handed over); used for the run cap. */
export async function countProcessed(ctx) {
  const seen = new Set()
  for (const label of [LABELS.prOpen, LABELS.needsHuman]) {
    for (const issue of await listAll(ctx, `/issues?state=all&labels=${encodeURIComponent(label)}`)) {
      if (!issue.pull_request) seen.add(issue.number)
    }
  }
  return seen.size
}

/** The parts of an issue that matter for reproducing it. The body is the user's text and is treated as data. */
export function bugSummary(issue) {
  return { id: issue.number, title: issue.title || '', description: issue.body || '', author: issue.user?.login || '', webUrl: issue.html_url }
}

export function postComment(ctx, number, body) {
  return api(ctx, 'POST', `/issues/${number}/comments`, { body })
}

export async function updateIssue(ctx, number, { addLabels = [], removeLabels = [], assignee = '', comment = '' } = {}) {
  if (addLabels.length > 0) await api(ctx, 'POST', `/issues/${number}/labels`, { labels: addLabels })
  for (const label of removeLabels) {
    try {
      await api(ctx, 'DELETE', `/issues/${number}/labels/${encodeURIComponent(label)}`)
    } catch (err) {
      if (err.status !== 404) throw err
    }
  }
  if (assignee) await api(ctx, 'POST', `/issues/${number}/assignees`, { assignees: [assignee] })
  if (comment) await postComment(ctx, number, comment)
}

/**
 * Marks an issue as taken by this run. GitHub has no conditional update, so the issue is read again
 * first; the workflow's concurrency group makes sure only one run claims at a time.
 */
export async function claimIssue(ctx, issue, note) {
  const current = await getIssue(ctx, issue.number)
  if (!isEligible(current)) return false
  await updateIssue(ctx, issue.number, { addLabels: [LABELS.inProgress], comment: note })
  return true
}

// --- Pull requests --------------------------------------------------------------------------------

export function createPullRequest(ctx, { sourceBranch, targetBranch = 'main', title, body, draft = false }) {
  return api(ctx, 'POST', '/pulls', { title: String(title).slice(0, 250), head: sourceBranch, base: targetBranch, body: String(body).slice(0, 60000), draft })
}

export function getPullRequest(ctx, number) {
  return api(ctx, 'GET', `/pulls/${number}`)
}

export async function listAutofixPullRequests(ctx, targetBranch = 'main') {
  const prs = await listAll(ctx, `/pulls?state=open&base=${encodeURIComponent(targetBranch)}`)
  return prs.filter((pr) => pr.head.ref.startsWith('autofix/') && !pr.draft && pr.head.repo?.full_name === ctx.repo)
}

/** State of the Claude review commit status on a commit: 'success', 'failure', 'error', 'pending' or null. */
export async function reviewState(ctx, sha) {
  const statuses = await api(ctx, 'GET', `/commits/${sha}/statuses?per_page=100`)
  return (statuses || []).find((s) => s.context === REVIEW_STATUS_CONTEXT)?.state ?? null
}

export async function prChangesRequested(ctx, number) {
  return hasChangesRequested(await listAll(ctx, `/pulls/${number}/reviews`))
}

export async function prFindings(ctx, number) {
  return openReviewFindings([...(await listAll(ctx, `/pulls/${number}/comments`)), ...(await listAll(ctx, `/issues/${number}/comments`))])
}

export function addLabels(ctx, number, labels) {
  return api(ctx, 'POST', `/issues/${number}/labels`, { labels })
}

/** Whether the target branch guarantees a human approval. Unknown counts as no. */
export async function branchRequiresApproval(ctx, branch) {
  try {
    return requiresApproval(await api(ctx, 'GET', `/rules/branches/${encodeURIComponent(branch)}`))
  } catch (err) {
    console.log(`Could not read the branch rules (${err.message}); assuming no approval rule.`)
    return false
  }
}

async function graphql(ctx, query, variables) {
  if (DRY_RUN) {
    console.log(`[dry-run] GraphQL ${query.split('(')[0].trim()}`)
    return { dryRun: true }
  }
  const result = await request(ctx, 'POST', ctx.graphql, { query, variables })
  if (result?.errors?.length) throw new Error(result.errors.map((e) => e.message).join('; '))
  return result?.data
}

/** Auto-merge: the PR merges by itself once every rule on the target branch (checks, approval) is satisfied. */
export function enableAutoMerge(ctx, pr) {
  return graphql(ctx, 'mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId } }', { id: pr.node_id })
}

export function disableAutoMerge(ctx, pr) {
  return graphql(ctx, 'mutation($id: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $id }) { clientMutationId } }', { id: pr.node_id })
}
