// Publish job, last step: hand the issue to a person whenever the automation did not end with an open pull request.
//
// Runs at the end of every run that claimed an issue (also after a failed job). It labels the issue
// "claude-needs-human", releases the claim, optionally assigns the owner and explains what happened.
// Partial work that passes the guardrail is pushed as a draft PR so the person does not start from zero.
// To let the automation retry, remove the "claude-needs-human" label from the issue.
//
// Environment:
//   GH_TOKEN               token with issues: write (and push rights for the draft PR)
//   AUTOFIX_HANDOVER_TO    GitHub login of the person who takes over (optional)
//   AUTOFIX_TARGET_BRANCH  default main
import { existsSync } from 'node:fs'
import { applyPatch, commitAndPush, git, remoteBranchExists, stagedNumstat } from './claude.mjs'
import { DRY_RUN, LABELS, MARKER, bugBranch, checkChange, context, createPullRequest, limitsFromEnv, logIssue, outPath, readJson, updateIssue } from './issues.mjs'

const bug = readJson('bug.json')
if (!bug) {
  console.log('No issue was claimed in this run; nothing to hand over.')
  process.exit(0)
}
const result = readJson('result.json')
const pr = readJson('pr.json')
const rejected = readJson('handover.json')
if (result?.status === 'fixed' && (pr || DRY_RUN) && !rejected) {
  console.log(`Issue #${bug.id} has an open pull request; no handover needed.`)
  process.exit(0)
}

const ctx = context()
const info =
  rejected ||
  (result?.status === 'fixed'
    ? { stage: 'pull request', reason: 'The fix was verified but the pull request could not be created; see the workflow run.', pushable: false }
    : { stage: 'pipeline', reason: 'The workflow stopped before the fix was complete; see the workflow run.', pushable: false })

// Partial work is pushed only when it passes the guardrail on a clean checkout (changes limited to app/ and tests/, small diff).
let draftUrl = ''
if (info.pushable && !DRY_RUN && !pr && existsSync(outPath('change.patch'))) {
  try {
    git(['reset', '--hard'])
    let branch = bugBranch(bug.id)
    if (remoteBranchExists(branch)) branch = bugBranch(bug.id, process.env.GITHUB_RUN_ID || Date.now())
    git(['checkout', '-B', branch])
    applyPatch('change.patch')
    const change = checkChange(stagedNumstat(), limitsFromEnv())
    if (change.ok && change.files.length > 0) {
      commitAndPush(branch, `WIP #${bug.id}: unverified auto-fix attempt`)
      const draft = await createPullRequest(ctx, {
        sourceBranch: branch,
        targetBranch: process.env.AUTOFIX_TARGET_BRANCH || 'main',
        title: `[Needs human] #${bug.id}: ${bug.title}`.slice(0, 200),
        body: `<!-- ${MARKER}:draft {"issue":${bug.id}} -->\nUnfinished automated attempt for #${bug.id}. **Not verified.**\n\nStopped at: ${info.stage}\n\n${info.reason}`,
        draft: true,
      })
      draftUrl = draft.html_url
      console.log(`Pushed the partial work as draft PR #${draft.number}.`)
    } else {
      console.log(`The partial work was not pushed: ${change.violations.join('; ') || 'empty patch'}.`)
    }
  } catch (err) {
    logIssue('warning', `Could not push the partial work for issue #${bug.id}: ${err.message}`)
  }
}

const comment = [
  `<!-- ${MARKER}:handover -->`,
  '**Claude auto-fix could not finish this issue and is handing it over to a person.**',
  '',
  `- Stopped at: ${info.stage}`,
  `- Reason: ${String(info.reason).replace(/[\r\n]+/g, ' ')}`,
  info.repro ? `- Reproduced by: ${info.repro.files.map((f) => `\`${f}\``).join(', ')} (${info.repro.failedTests.length} failing test(s))` : '- The bug was not reproduced by an automated test.',
  ctx.buildUrl ? `- [Workflow run and logs](${ctx.buildUrl})` : '',
  draftUrl ? `- [Draft pull request with the partial work](${draftUrl})` : '',
  '',
  `To let the automation try again, remove the label \`${LABELS.needsHuman}\`.`,
]
  .filter((line) => line !== '')
  .join('\n')

const update = { addLabels: [LABELS.needsHuman], removeLabels: [LABELS.inProgress], assignee: (process.env.AUTOFIX_HANDOVER_TO || '').trim(), comment }
try {
  await updateIssue(ctx, bug.id, update)
} catch (err) {
  // An unknown assignee must not leave the issue claimed forever; retry without the assignment.
  if (!update.assignee) throw err
  logIssue('warning', `Could not assign issue #${bug.id} to "${update.assignee}" (${err.message}); handing over without an assignee.`)
  await updateIssue(ctx, bug.id, { ...update, addLabels: [], assignee: '' })
}
logIssue('warning', `Issue #${bug.id} was handed over to a person (${info.stage}): ${info.reason}`)
