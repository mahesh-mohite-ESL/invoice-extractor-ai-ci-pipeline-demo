// Shared helpers for the PR review scripts on GitHub Actions. Plain Node (>=20), no dependencies.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const OUT_DIR = 'pr-review-output'
export const MARKER = 'claude-review'
/** Commit status the review sets on the PR head; the auto-fix workflow reads it. */
export const STATUS_CONTEXT = 'claude/review'

export function ensureOutDir() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
}

export function outPath(name) {
  return join(OUT_DIR, name)
}

export function readJson(name, fallback) {
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

/** Stable fingerprint for a finding so the same issue is not posted twice. */
export function fingerprint(finding) {
  const file = String(finding.file || '').replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase()
  const title = String(finding.title || '').trim().toLowerCase().replace(/\s+/g, ' ')
  return createHash('sha1').update(`${file}|${title}`).digest('hex').slice(0, 12)
}

/**
 * Pull request context from the GitHub Actions event. Returns null when the run is not a
 * pull_request event. The token is optional here; `gh` fails if a call needs it and it is missing.
 */
export function prContext() {
  const repo = process.env.GITHUB_REPOSITORY
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!repo || !eventPath || !existsSync(eventPath)) return null
  let pr
  try {
    pr = JSON.parse(readFileSync(eventPath, 'utf8')).pull_request
  } catch {
    return null
  }
  if (!pr) return null
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com'
  return {
    api: `${process.env.GITHUB_API_URL || 'https://api.github.com'}/repos/${repo}`,
    prId: pr.number,
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '',
    targetBranch: pr.base.ref,
    sourceBranch: pr.head.ref,
    sourceCommit: pr.head.sha,
    buildUrl: `${server}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`,
  }
}

/** Calls the GitHub REST API. `path` is relative to /repos/{owner}/{repo}. */
export async function gh(ctx, method, path, body) {
  if (!ctx.token) throw new Error('GH_TOKEN is not set. Map it in the workflow step: env: { GH_TOKEN: ${{ github.token }} }')
  const res = await fetch(`${ctx.api}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'claude-pr-review',
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
    const err = new Error(`GitHub ${method} ${path} failed: ${res.status} ${res.statusText} ${text.slice(0, 400)}`)
    err.status = res.status
    throw err
  }
  return json
}

/** GET for list endpoints: follows pages until one is not full (at most 10 pages). */
export async function ghAll(ctx, path) {
  const items = []
  for (let page = 1; page <= 10; page++) {
    const batch = await gh(ctx, 'GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    items.push(...(batch || []))
    if (!batch || batch.length < 100) break
  }
  return items
}

const escapeData = (s) => String(s).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
const escapeProp = (s) => escapeData(s).replaceAll(':', '%3A').replaceAll(',', '%2C')

/** Emits a workflow command so the issue appears as an annotation on the run and on the changed file. */
export function logIssue(type, message, file, line) {
  const props = []
  if (file) props.push(`file=${escapeProp(file)}`)
  if (line) props.push(`line=${line}`)
  console.log(`::${type === 'error' ? 'error' : 'warning'}${props.length ? ` ${props.join(',')}` : ''}::${escapeData(message)}`)
}
