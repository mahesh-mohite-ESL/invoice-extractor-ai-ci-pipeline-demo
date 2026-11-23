// Step 4: fail the job (and therefore the required status check) when blocking findings exist.
//   REVIEW_FAIL_ON   comma-separated severities that block, default "critical"
import { logIssue, readJson } from './github.mjs'

const review = readJson('findings.json', null)
if (!review) {
  logIssue('error', 'No findings.json produced; treating the review as failed.')
  process.exit(1)
}

const failOn = (process.env.REVIEW_FAIL_ON || 'critical')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean)

const counts = {}
for (const f of review.findings) counts[f.severity] = (counts[f.severity] || 0) + 1

console.log(`Verdict: ${review.verdict}`)
console.log('Findings by severity:')
for (const s of ['critical', 'high', 'medium', 'low', 'info']) console.log(`  ${s.padEnd(8)} ${counts[s] || 0}`)

const blocking = review.findings.filter((f) => failOn.includes(f.severity))
if (blocking.length > 0) {
  console.log(`\n${blocking.length} blocking finding(s) (severity in: ${failOn.join(', ')}):`)
  for (const f of blocking) console.log(`  - [${f.severity}] ${f.file}:${f.line} ${f.title}`)
  logIssue('error', `Merge blocked: ${blocking.length} finding(s) with severity ${failOn.join('/')}.`)
  process.exit(1)
}

console.log(`\nNo findings with severity ${failOn.join('/')}; review gate passed.`)
