// Step 3: post the review back to the pull request (summary comment + inline comments, skipping
// duplicates) and set the commit status "claude/review". Never fails the run by itself; gate.mjs decides that.
//
// Env:
//   GH_TOKEN         token with pull-requests: write and statuses: write
//   REVIEW_FAIL_ON   comma-separated severities that block (used for the status text), default "critical"
import { MARKER, STATUS_CONTEXT, fingerprint, gh, logIssue, prContext, readJson } from './github.mjs'

const ctx = prContext()
if (!ctx) {
  console.log('Not a pull request run; nothing to post.')
  process.exit(0)
}

const failOn = new Set(
  (process.env.REVIEW_FAIL_ON || 'critical')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
)

function postComment(body) {
  return gh(ctx, 'POST', `/issues/${ctx.prId}/comments`, { body })
}

async function postFinding(body, { file, line }) {
  if (file && line > 0) {
    try {
      return await gh(ctx, 'POST', `/pulls/${ctx.prId}/comments`, { body, commit_id: ctx.sourceCommit, path: file, line, side: 'RIGHT' })
    } catch (err) {
      // 422: the line is not part of the PR diff. Post as a general comment instead.
      if (err.status !== 422) throw err
      return postComment(`${body}\n\n_(could not anchor to ${file}:${line})_`)
    }
  }
  return postComment(body)
}

async function setStatus(state, description) {
  try {
    await gh(ctx, 'POST', `/statuses/${ctx.sourceCommit}`, { state, description: description.slice(0, 140), context: STATUS_CONTEXT, target_url: ctx.buildUrl })
  } catch (err) {
    console.log(`Could not set the commit status (non-fatal): ${err.message}`)
  }
}

async function main() {
  const review = readJson('findings.json', null)
  const prior = readJson('prior_findings.json', [])
  const priorFps = new Set(prior.map((p) => p.fp))

  if (!review) {
    await postComment(`<!-- ${MARKER}:summary -->\n## Claude PR Review\n\nThe review did not complete. Check the workflow run: ${ctx.buildUrl}`)
    await setStatus('error', 'Claude review did not complete')
    logIssue('warning', 'findings.json missing; posted a failure notice to the PR.')
    return
  }

  const all = review.findings.map((f) => ({ ...f, fp: fingerprint(f) }))
  const fresh = all.filter((f) => !priorFps.has(f.fp))
  const skipped = all.length - fresh.length

  const counts = Object.fromEntries(['critical', 'high', 'medium', 'low', 'info'].map((s) => [s, 0]))
  for (const f of all) counts[f.severity] = (counts[f.severity] || 0) + 1

  // Always surface the findings in the run log first, so they are visible even if posting fails.
  console.log(`Verdict: ${review.verdict}. ${all.length} finding(s), ${fresh.length} new.`)
  for (const f of all) {
    logIssue(f.severity === 'critical' || f.severity === 'high' ? 'error' : 'warning', `[${f.severity}] ${f.title}`, f.file, f.line)
  }

  const summaryBody = [
    `<!-- ${MARKER}:summary -->`,
    '## Claude PR Review',
    '',
    `**Verdict:** \`${review.verdict}\``,
    '',
    review.summary,
    '',
    '| Severity | Count |',
    '|---|---|',
    ...Object.entries(counts).map(([s, n]) => `| ${s} | ${n} |`),
    '',
    skipped ? `${skipped} finding(s) were already posted on this PR and were not repeated.` : '',
    `_Model: ${review.meta?.model ?? 'n/a'} · cost: $${review.meta?.cost_usd?.toFixed?.(4) ?? 'n/a'} · [workflow run](${ctx.buildUrl})_`,
  ].join('\n')

  await postComment(summaryBody)
  console.log(`Posted summary to PR #${ctx.prId}.`)

  for (const f of fresh) {
    const meta = JSON.stringify({ fp: f.fp, severity: f.severity, file: f.file, line: f.line, title: f.title })
    const body = [
      `<!-- ${MARKER}:finding ${meta} -->`,
      `**[${f.severity.toUpperCase()}] ${f.title}**`,
      `_${f.category}_ · \`${f.file}${f.line ? `:${f.line}` : ''}\``,
      '',
      f.description,
      f.suggestion ? `\n**Suggested fix:** ${f.suggestion}` : '',
    ].join('\n')
    await postFinding(body, f)
  }
  console.log(`Posted ${fresh.length} new finding(s); skipped ${skipped} duplicate(s).`)

  const blockingCount = all.filter((f) => failOn.has(f.severity)).length
  await setStatus(
    blockingCount > 0 ? 'failure' : 'success',
    blockingCount > 0 ? `${blockingCount} blocking finding(s) (${[...failOn].join('/')})` : `${all.length} finding(s), none blocking`,
  )
}

try {
  await main()
} catch (err) {
  if (err?.status === 403) {
    logIssue('warning', `Cannot post to PR #${ctx.prId}: the token lacks permission. The job needs "pull-requests: write" and "statuses: write". ${err.message.slice(0, 200)}`)
  } else {
    logIssue('warning', `Posting the review to the pull request failed: ${err?.message ?? err}`)
  }
  // Findings are already in the run log and in the claude-review artifact; gate.mjs still enforces the policy.
  process.exitCode = 0
}
