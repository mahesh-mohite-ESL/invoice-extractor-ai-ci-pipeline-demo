// Select job, step 2: pick the oldest issue that opted in to auto-fix (label "claude-autofix") and claim it.
// Writes autofix-output/bug.json and sets the step outputs hasBug (true/false) and issue.
//
// Environment:
//   GH_TOKEN            token with issues: write
//   AUTOFIX_ISSUE       optional issue number for a manual run; skips the query (the label is not required then)
//   AUTOFIX_MAX_RUNS    optional cap on how many issues the automation may process in total (0 or empty = no cap)
import { LABELS, bugSummary, claimIssue, context, countProcessed, findEligibleIssues, getIssue, hasLabel, logIssue, setOutput, updateIssue, writeJson } from './issues.mjs'

const ctx = context()
const manual = (process.env.AUTOFIX_ISSUE || '').trim()
const maxRuns = Number(process.env.AUTOFIX_MAX_RUNS || 0)
const note = `Claude auto-fix picked up this issue.${ctx.buildUrl ? ` [Workflow run](${ctx.buildUrl})` : ''}`

function none(message) {
  setOutput('hasBug', 'false')
  console.log(message)
  process.exit(0)
}

if (maxRuns > 0) {
  const processed = await countProcessed(ctx)
  if (processed >= maxRuns) {
    logIssue('warning', `AUTOFIX_MAX_RUNS reached (${processed}/${maxRuns}); no new issue is picked up. Raise the repository variable to continue.`)
    none('Run cap reached.')
  }
}

let candidates
if (manual && manual !== '0') {
  if (!/^\d+$/.test(manual)) {
    logIssue('error', `The issue input must be a number, got "${manual}".`)
    process.exit(1)
  }
  const issue = await getIssue(ctx, manual)
  if (issue.pull_request || issue.state !== 'open') {
    logIssue('error', `#${manual} is not an open issue.`)
    process.exit(1)
  }
  if (hasLabel(issue, LABELS.prOpen) || hasLabel(issue, LABELS.inProgress)) {
    logIssue('error', `Issue #${manual} is already being handled (label ${LABELS.inProgress} or ${LABELS.prOpen}). Remove the label to retry.`)
    process.exit(1)
  }
  // A manual run may target an issue without the opt-in label; add it so the claim check passes.
  if (!hasLabel(issue, LABELS.optIn)) issue.labels = [...(issue.labels || []), { name: LABELS.optIn }]
  candidates = [issue]
} else {
  candidates = await findEligibleIssues(ctx)
  console.log(`${candidates.length} eligible issue(s): ${candidates.map((i) => `#${i.number}`).join(', ') || 'none'}`)
}

for (const issue of candidates) {
  const claimed = manual && manual !== '0' ? await claimManual(issue) : await claimIssue(ctx, issue, note)
  if (claimed) {
    const bug = bugSummary(issue)
    writeJson('bug.json', bug)
    setOutput('hasBug', 'true')
    setOutput('issue', String(bug.id))
    console.log(`Claimed issue #${bug.id}: ${bug.title}`)
    process.exit(0)
  }
  console.log(`Issue #${issue.number} changed while it was being claimed; skipping it in this run.`)
}

none('No issue to work on.')

async function claimManual(issue) {
  await updateIssue(ctx, issue.number, { addLabels: [LABELS.optIn, LABELS.inProgress], removeLabels: [LABELS.needsHuman], comment: note })
  return true
}
