// Unit tests for the pure helpers of the auto-fix workflow. Run with: npm run test:autofix
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scrubbedEnv } from './claude.mjs'
import {
  FIXUP_LABEL,
  LABELS,
  bugBranch,
  bugIdFromBranch,
  checkChange,
  failedTests,
  hasChangesRequested,
  isEligible,
  isPytestModule,
  isTestFile,
  openReviewFindings,
  requiresApproval,
  reviewAction,
} from './issues.mjs'

const issue = (labels, over = {}) => ({ state: 'open', labels: labels.map((name) => ({ name })), ...over })

test('isEligible requires an open issue with the opt-in label and no automation state label', () => {
  assert.equal(isEligible(issue(['claude-autofix'])), true)
  assert.equal(isEligible(issue(['bug', 'Claude-Autofix'])), true)
  assert.equal(isEligible(issue(['claude-autofix-later'])), false)
  assert.equal(isEligible(issue([])), false)
  assert.equal(isEligible(issue(['claude-autofix'], { state: 'closed' })), false)
  assert.equal(isEligible(issue(['claude-autofix'], { pull_request: {} })), false)
  for (const label of [LABELS.inProgress, LABELS.prOpen, LABELS.needsHuman]) assert.equal(isEligible(issue(['claude-autofix', label])), false)
})

test('checkChange accepts small changes under app/ and tests/ only', () => {
  assert.deepEqual(checkChange('3\t1\tapp/normalize.py\n10\t0\ttests/test_normalize.py\n'), {
    ok: true,
    violations: [],
    files: ['app/normalize.py', 'tests/test_normalize.py'],
    lines: 14,
  })
  assert.equal(checkChange('').ok, true)
})

test('checkChange rejects workflow, script, config, dependency, binary, renamed and oversized changes', () => {
  for (const file of [
    '.github/workflows/autofix.yml',
    '.github/workflows/ci-review.yml',
    'scripts/autofix/run-fix.mjs',
    '.claude/settings.json',
    'CLAUDE.md',
    'requirements.txt',
    'pyproject.toml',
    'samples/cache/acme-usd.json',
    'appx/evil.py',
    'app/../scripts/x.py',
    'app/{a.py => ../b.py}',
  ]) {
    assert.equal(checkChange(`1\t1\t${file}\n`).ok, false, file)
  }
  assert.equal(checkChange('-\t-\tapp/static/logo.png\n').ok, false)
  assert.equal(checkChange('200\t101\tapp/normalize.py\n').ok, false)
  assert.equal(checkChange('200\t101\tapp/normalize.py\n', { maxLines: 400 }).ok, true)
})

test('checkChange lets tests grow but rejects removed or changed lines under tests/', () => {
  assert.equal(checkChange('12\t0\ttests/test_validate.py\n').ok, true)
  assert.equal(checkChange('20\t0\ttests/fixtures/orbit-discount.json\n').ok, true)
  assert.equal(checkChange('12\t1\ttests/test_validate.py\n').ok, false)
  assert.equal(checkChange('0\t40\ttests/test_api.py\n').ok, false)
  assert.equal(checkChange('1\t1\ttests/fixtures/acme-usd.json\n').ok, false)
  assert.equal(checkChange('12\t1\ttests/test_validate.py\n', { protectTests: false }).ok, true)
  assert.equal(checkChange('5\t5\tapp/validate.py\n').ok, true)
})

test('isTestFile and isPytestModule only match simple paths under tests/', () => {
  assert.equal(isTestFile('tests/test_normalize.py'), true)
  assert.equal(isTestFile('tests/fixtures/new-case.json'), true)
  assert.equal(isTestFile('app/normalize.py'), false)
  assert.equal(isTestFile('tests/../app/x.py'), false)
  assert.equal(isTestFile('tests/test_a.py; rm -rf .'), false)
  assert.equal(isPytestModule('tests/test_normalize.py'), true)
  assert.equal(isPytestModule('tests/unit/test_dates.py'), true)
  assert.equal(isPytestModule('tests/conftest.py'), false)
  assert.equal(isPytestModule('tests/fixtures/new-case.json'), false)
})

test('failedTests lists test cases with a failure and ignores passed ones and collection errors', () => {
  const xml = [
    '<testsuites><testsuite name="pytest" errors="1" failures="2" tests="4">',
    '<testcase classname="tests.test_normalize" name="test_ok" time="0.001" />',
    '<testcase classname="tests.test_normalize" name="test_day_first" time="0.002"><failure message="assert a &gt; b">trace</failure></testcase>',
    '<testcase classname="tests.test_validate" name="test_discount[a&gt;b]" time="0.002"><failure message="x">trace</failure></testcase>',
    '<testcase classname="" name="tests.test_broken" time="0.000"><error message="collection failure">ImportError</error></testcase>',
    '</testsuite></testsuites>',
  ].join('')
  assert.deepEqual(failedTests(xml), ['tests.test_normalize::test_day_first', 'tests.test_validate::test_discount[a&gt;b]'])
  assert.deepEqual(failedTests(''), [])
})

test('scrubbedEnv drops credentials and runner command files and keeps only what is asked for', () => {
  const saved = { ...process.env }
  Object.assign(process.env, { GH_TOKEN: 't', GITHUB_TOKEN: 'g', AUTOFIX_TOKEN: 'p', ANTHROPIC_API_KEY: 'k', MY_SECRET: 's', DB_PASSWORD: 'x', GITHUB_ENV: '/tmp/env', GITHUB_PATH: '/tmp/path', GITHUB_OUTPUT: '/tmp/out', AUTOFIX_MODEL: 'm', GITHUB_REPOSITORY: 'o/r' })
  try {
    const env = scrubbedEnv()
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'AUTOFIX_TOKEN', 'ANTHROPIC_API_KEY', 'MY_SECRET', 'DB_PASSWORD', 'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT']) assert.equal(env[name], undefined, name)
    assert.equal(env.AUTOFIX_MODEL, 'm')
    assert.equal(env.GITHUB_REPOSITORY, 'o/r')
    assert.equal(env.CI, 'true')
    assert.ok(Object.keys(env).some((k) => k.toUpperCase() === 'PATH'))
    const forClaude = scrubbedEnv(['ANTHROPIC_API_KEY'])
    assert.equal(forClaude.ANTHROPIC_API_KEY, 'k')
    assert.equal(forClaude.GH_TOKEN, undefined)
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
  }
})

test('requiresApproval only accepts a pull request rule with at least one approving review', () => {
  assert.equal(requiresApproval([{ type: 'pull_request', parameters: { required_approving_review_count: 1 } }]), true)
  assert.equal(requiresApproval([{ type: 'pull_request', parameters: { required_approving_review_count: 0 } }]), false)
  assert.equal(requiresApproval([{ type: 'required_status_checks', parameters: {} }]), false)
  assert.equal(requiresApproval([]), false)
  assert.equal(requiresApproval(null), false)
})

test('hasChangesRequested uses the latest review of each person', () => {
  const review = (login, state) => ({ user: { login }, state })
  assert.equal(hasChangesRequested([review('a', 'CHANGES_REQUESTED')]), true)
  assert.equal(hasChangesRequested([review('a', 'CHANGES_REQUESTED'), review('a', 'APPROVED')]), false)
  assert.equal(hasChangesRequested([review('a', 'CHANGES_REQUESTED'), review('a', 'COMMENTED')]), true)
  assert.equal(hasChangesRequested([review('a', 'APPROVED'), review('b', 'CHANGES_REQUESTED')]), true)
  assert.equal(hasChangesRequested([]), false)
})

test('branch names round-trip the issue number', () => {
  assert.equal(bugBranch(42), 'autofix/issue-42')
  assert.equal(bugBranch(42, 3650), 'autofix/issue-42-3650')
  assert.equal(bugIdFromBranch('autofix/issue-42-3650'), 42)
  assert.equal(bugIdFromBranch('feature/x'), null)
})

test('openReviewFindings returns only Claude review findings', () => {
  const finding = (id, meta) => ({ id, body: `<!-- claude-review:finding ${JSON.stringify(meta)} -->\n**[HIGH] ${meta.title}**\nDetails` })
  const comments = [
    finding(1, { severity: 'high', file: 'app/a.py', line: 3, title: 'Bug A' }),
    { id: 2, body: 'A human comment' },
    { id: 3, body: '<!-- claude-review:summary -->\n## Claude PR Review' },
    { id: 4, body: '<!-- claude-review:finding {broken -->' },
    { id: 5, body: null },
  ]
  const found = openReviewFindings(comments)
  assert.equal(found.length, 1)
  assert.equal(found[0].commentId, 1)
  assert.equal(found[0].title, 'Bug A')
  assert.equal(found[0].body, '**[HIGH] Bug A**\nDetails')
})

test('reviewAction decides between wait, fixup, giveup and human', () => {
  assert.equal(reviewAction({}), 'wait')
  assert.equal(reviewAction({ reviewState: 'success' }), 'wait')
  assert.equal(reviewAction({ reviewState: 'pending' }), 'wait')
  // Failed review of the head commit: fix up once, then give up.
  assert.equal(reviewAction({ reviewState: 'failure' }), 'fixup')
  assert.equal(reviewAction({ reviewState: 'failure', labels: [FIXUP_LABEL] }), 'giveup')
  // The fix-up commit has not been reviewed yet.
  assert.equal(reviewAction({ reviewState: null, labels: [FIXUP_LABEL] }), 'wait')
  // People take precedence over the automation.
  assert.equal(reviewAction({ reviewState: 'failure', changesRequested: true }), 'human')
  assert.equal(reviewAction({ reviewState: 'failure', labels: [LABELS.needsHuman] }), 'human')
})
