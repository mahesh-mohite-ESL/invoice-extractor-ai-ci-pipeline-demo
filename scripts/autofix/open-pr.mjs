// Publish job, step 2: apply the verified patch to a fresh checkout, check it again, push it and open a pull request.
//
// The patch was produced in the fix job, where code written by Claude ran. Nothing else from that
// job is trusted: this script runs from a clean checkout and re-applies the path and size guardrail.
// The build and the Claude review then run on the pull request like on any other.
//
// Auto-merge is enabled only when the target branch requires an approving review; otherwise a person merges.
//
// Environment:
//   GH_TOKEN               token that may push branches and open pull requests (AUTOFIX_TOKEN)
//   AUTOFIX_TARGET_BRANCH  default main
import { existsSync } from 'node:fs'
import { applyPatch, commitAndPush, git, remoteBranchExists, stagedNumstat } from './claude.mjs'
import {
  DRY_RUN,
  LABELS,
  MARKER,
  addLabels,
  branchRequiresApproval,
  bugBranch,
  checkChange,
  context,
  createPullRequest,
  enableAutoMerge,
  limitsFromEnv,
  logIssue,
  outPath,
  readJson,
  updateIssue,
  writeJson,
} from './issues.mjs'

const bug = readJson('bug.json')
const result = readJson('result.json')
if (!bug || result?.status !== 'fixed') {
  console.log('No verified fix in this run; no pull request to open.')
  process.exit(0)
}

function reject(reason) {
  writeJson('handover.json', { stage: 'guardrail', reason, pushable: false, repro: result.repro || null })
  logIssue('warning', `The fix for issue #${bug.id} was not published: ${reason}`)
  process.exit(0)
}

const ctx = context()
const target = process.env.AUTOFIX_TARGET_BRANCH || 'main'
const testCases = readJson('test-cases.json', [])
const title = `Fix #${bug.id}: ${bug.title}`.slice(0, 200)

if (!existsSync(outPath('change.patch'))) reject('The fix job did not produce a patch.')
try {
  applyPatch('change.patch')
} catch (err) {
  reject(`The patch does not apply to a clean checkout: ${err.message.slice(0, 300)}`)
}
const change = checkChange(stagedNumstat(), limitsFromEnv())
if (!change.ok) reject(`The patch was rejected: ${change.violations.join('; ')}.`)
if (change.files.length === 0) reject('The patch is empty.')

const list = (items) => items.map((item) => String(item).replace(/[\r\n]+/g, ' '))
const body = [
  `<!-- ${MARKER}:pr {"issue":${bug.id}} -->`,
  `Automated fix for #${bug.id}, written by Claude and verified by the auto-fix workflow. **A person must review it before it merges.**`,
  '',
  `Fixes #${bug.id}`,
  '',
  '### Root cause',
  result.fix.rootCause,
  '',
  '### Change',
  result.fix.summary,
  '',
  ...change.files.map((f) => `- \`${f}\``),
  '',
  '### Evidence',
  `- Reproduced first: ${result.repro.failedTests.length} test(s) failed before the fix and pass now.`,
  ...list(result.repro.failedTests.slice(0, 8)).map((t) => `  - \`${t}\``),
  `- Checks passed in the workflow: ${list(result.verification).join(', ')}.`,
  testCases.length > 0 ? `- Manual test cases are listed on #${bug.id}.` : '',
  '',
  `_Fix attempts: ${result.fix.attempts} · cost: $${result.costUsd}${ctx.buildUrl ? ` · [workflow run](${ctx.buildUrl})` : ''}_`,
]
  .filter((line) => line !== undefined)
  .join('\n')

if (DRY_RUN) {
  console.log(`[dry-run] would push ${bugBranch(bug.id)} and open this pull request against ${target}:\n\n${title}\n\n${body}`)
  process.exit(0)
}

if (process.env.HAS_AUTOFIX_TOKEN !== 'true') {
  logIssue('warning', 'The secret AUTOFIX_TOKEN is not set. The pull request is created with the workflow token, so the build and review checks will NOT start on it. See docs/SETUP-GUIDE.md, step 3.')
}

// A branch from an earlier attempt may still exist; never overwrite it.
let branch = bugBranch(bug.id)
if (remoteBranchExists(branch)) branch = bugBranch(bug.id, process.env.GITHUB_RUN_ID || Date.now())

git(['checkout', '-B', branch])
const commit = commitAndPush(branch, `${title}\n\n${result.fix.summary}`)
console.log(`Pushed ${commit.slice(0, 8)} to ${branch}.`)

const pr = await createPullRequest(ctx, { sourceBranch: branch, targetBranch: target, title, body })
writeJson('pr.json', { id: pr.number, url: pr.html_url, branch, commit })
console.log(`Opened pull request #${pr.number}: ${pr.html_url}`)

try {
  await addLabels(ctx, pr.number, [LABELS.optIn])
} catch (err) {
  console.log(`Could not label PR #${pr.number}: ${err.message}`)
}

let mergeNote = 'A person reviews and merges it.'
if (await branchRequiresApproval(ctx, target)) {
  try {
    await enableAutoMerge(ctx, pr)
    mergeNote = 'It merges by itself once the checks pass and a person approves.'
    console.log('Auto-merge is enabled; the PR merges once all rules pass and a person approves.')
  } catch (err) {
    logIssue('warning', `Could not enable auto-merge on PR #${pr.number} (is "Allow auto-merge" on in the repository settings?). Merge it manually after approval. ${err.message}`)
  }
} else {
  console.log(`Auto-merge was not enabled: branch ${target} does not require an approving review, so nothing would guarantee a human decision.`)
}

await updateIssue(ctx, bug.id, {
  addLabels: [LABELS.prOpen],
  removeLabels: [LABELS.inProgress],
  comment: `Claude auto-fix opened pull request #${pr.number} for this issue. ${mergeNote}`,
})
