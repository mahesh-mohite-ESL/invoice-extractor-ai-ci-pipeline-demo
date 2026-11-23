// Step 1: load findings already posted on this PR so the review can skip them (dedup).
import { MARKER, ghAll, prContext, writeJson, writeText } from './github.mjs'

const ctx = prContext()
if (!ctx) {
  console.log('Not a pull request run; no prior findings to load.')
  writeJson('prior_findings.json', [])
  writeText('prior_findings.txt', '')
  process.exit(0)
}

// Findings are inline review comments; ones that could not be anchored to a line are PR comments.
const comments = [...(await ghAll(ctx, `/pulls/${ctx.prId}/comments`)), ...(await ghAll(ctx, `/issues/${ctx.prId}/comments`))]
const prior = []
const re = new RegExp(`<!--\\s*${MARKER}:finding\\s+(\\{.*?\\})\\s*-->`, 's')

for (const comment of comments) {
  const match = (comment.body || '').match(re)
  if (!match) continue
  try {
    prior.push({ ...JSON.parse(match[1]), commentId: comment.id })
  } catch {
    // ignore malformed markers
  }
}

const text = prior.map((f) => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} - ${f.title}`).join('\n')

writeJson('prior_findings.json', prior)
writeText('prior_findings.txt', text)
console.log(`Loaded ${prior.length} prior finding(s) from PR #${ctx.prId}.`)
if (text) console.log(text)
