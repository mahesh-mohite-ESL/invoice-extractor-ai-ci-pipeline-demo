# Invoice extractor with Claude PR review and bug auto-fix

A small invoice PDF data-extraction service (Python, FastAPI, Claude API) together with two
GitHub Actions workflows:

- **Claude PR review** - every pull request is reviewed by Claude. Findings appear as inline
  comments, and critical or high findings block the merge.
- **Bug auto-fix** - label an issue `claude-autofix` and Claude reproduces the bug with a failing
  test, fixes it, and opens a pull request for a person to review and merge.

Both run on GitHub-hosted runners; there is nothing to install or host.

**To set up your own copy, follow [docs/SETUP-GUIDE.md](docs/SETUP-GUIDE.md).**

## Quick start (service only)

```
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest
uvicorn app.main:app --reload     # http://localhost:8000
```

No API key is needed for the bundled samples; their extraction results are cached in
`samples/cache/`. With `ANTHROPIC_API_KEY` set, `POST /extract/{sample_id}?refresh=true` calls
Claude again.

| Endpoint | Purpose |
|---|---|
| `GET /` | Page: sample PDF beside the extracted fields and validation warnings |
| `GET /samples` | List of sample invoices |
| `GET /samples/{id}.pdf` | The PDF |
| `POST /extract/{id}` | Raw extraction, normalised invoice and warnings |
| `GET /health` | Liveness check |

The samples are synthetic. The service deliberately contains five bugs for the auto-fix workflow
to work on; see [docs/PLANTED-BUGS.md](docs/PLANTED-BUGS.md).

## How the workflows work

```
Pull request ──> build (ruff, pytest) ──> claude_review ──> comments + pass/fail check

Issue labelled claude-autofix
   └─> select   claim the issue
   └─> fix      Claude: failing test, then fix; guardrails; output = one patch   (no write token)
   └─> publish  clean checkout, re-check patch, push branch, open pull request  (or hand over)
                       └─> the pull request goes through build + claude_review, a person merges
```

| File | Role |
|---|---|
| `.github/workflows/ci-review.yml` | Build, test and Claude review |
| `.github/workflows/autofix.yml` | Bug auto-fix |
| `.github/workflows/setup.yml` | Creates the labels (run once) |
| `scripts/pr-review/*.mjs` | Review: prior findings, run Claude, post comments, gate |
| `scripts/autofix/*.mjs` | Auto-fix: pick issue, run Claude, guardrails, open PR, handover |
| `CLAUDE.md` | Project conventions; its review and bug-fix sections are the rules Claude follows |

Architecture details are in [CLAUDE.md](CLAUDE.md).

## Secrets and variables

| Name | Kind | Required | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Secret | Yes | Claude API access for review and auto-fix |
| `AUTOFIX_TOKEN` | Secret | Yes, for auto-fix | Pushes the fix branch and opens the pull request so that checks run on it |
| `AUTOFIX_MAX_RUNS`, `AUTOFIX_BUDGET_USD`, `AUTOFIX_MODEL`, `AUTOFIX_HANDOVER_TO`, `REVIEW_MODEL`, `REVIEW_BUDGET_USD`, `REVIEW_FAIL_ON` | Variables | No | See the setup guide |

## Security notes

- The review job runs the repository's own scripts with the API key, so it only runs for branches
  inside the repository. Give write access only to people you would trust with that key.
- Bug reports are untrusted input. See "How it stays safe" in the setup guide for how the
  auto-fix workflow contains them.
