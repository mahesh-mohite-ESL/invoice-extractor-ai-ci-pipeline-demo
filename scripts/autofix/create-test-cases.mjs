// Publish job, step 1: record the reproduction as a manual test checklist on the issue.
// Runs whenever the bug was reproduced, also when the fix later needs a person.
// Writes autofix-output/test-cases.json. Never fails the run: test cases are documentation, not a gate.
import { MARKER, context, logIssue, postComment, readJson, writeJson } from './issues.mjs'

const bug = readJson('bug.json')
const repro = readJson('result.json')?.repro || readJson('handover.json')?.repro
if (!bug || !repro || !Array.isArray(repro.testCases) || repro.testCases.length === 0) {
  console.log('No reproduced bug in this run; no test cases to record.')
  process.exit(0)
}

// The text below was written by Claude from an untrusted bug report; keep it from breaking the Markdown.
const plain = (s) => String(s || '').replace(/[\r\n]+/g, ' ').replaceAll('<', '&lt;').slice(0, 300)

const cases = repro.testCases.slice(0, 10)
const body = [
  `<!-- ${MARKER}:test-cases -->`,
  '### Test cases for this bug',
  '',
  `Reproduced by ${repro.failedTests.length} automated test(s) in ${repro.files.map((f) => `\`${plain(f)}\``).join(', ')}. Manual checks:`,
  '',
  ...cases.flatMap((tc) => [
    `- [ ] **${plain(tc.title)}**`,
    ...(tc.steps || []).slice(0, 12).map((step, i) => `  ${i + 1}. ${plain(step)}`),
    `  - Expected: ${plain(tc.expected)}`,
    tc.automated_test ? `  - Automated test: \`${plain(tc.automated_test)}\`` : '',
  ]),
]
  .filter((line) => line !== '')
  .join('\n')

try {
  await postComment(context(), bug.id, body)
  console.log(`Posted ${cases.length} test case(s) on issue #${bug.id}.`)
} catch (err) {
  logIssue('warning', `Could not post the test cases on issue #${bug.id}: ${err.message}`)
}
writeJson('test-cases.json', cases.map((tc) => ({ title: tc.title })))
