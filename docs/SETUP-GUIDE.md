# Setup guide: Claude PR review and bug auto-fix on GitHub Actions

Follow these steps to get your own copy running: an invoice extraction service, an automated
Claude code review on every pull request, and a workflow that turns a labelled bug report into a
tested pull request.

Everything runs on GitHub-hosted runners. You do not install an agent or a server.

**Time:** about 30 minutes. **Cost:** Claude API usage only; budget roughly USD 1 per auto-fixed
bug and less per review (limits: USD 5 per bug, USD 2 per review, both configurable).

## Prerequisites

| You need | Notes |
|---|---|
| GitHub account | Free plan is enough for a public repository |
| Git | `git --version` |
| Python 3.12 or newer | `python --version` |
| Node 20 or newer | Only to run the workflow script tests locally (optional) |
| Anthropic API key | From the Anthropic Console. Set a monthly spend limit on it before you start |

## Step 1 - Create your copy

1. Open the template repository on GitHub and choose **Use this template > Create a new repository**.
   Make it **Public**. Do not fork: workflows are disabled on forks by default.
2. Clone it:

   ```
   git clone https://github.com/<you>/<repo>.git
   cd <repo>
   ```

## Step 2 - Run the service locally

No API key is needed: the extraction result of every sample invoice is stored in `samples/cache/`.

```
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest
uvicorn app.main:app --reload
```

Open http://localhost:8000, pick a sample and compare the PDF with the extracted fields.
Five of the seven samples show a wrong value or a false warning. That is on purpose: these are
the bugs you will let Claude fix in step 6. `docs/PLANTED-BUGS.md` lists them (spoilers).

## Step 3 - Add the secrets

1. **`ANTHROPIC_API_KEY`** - in your repository: **Settings > Secrets and variables > Actions >
   New repository secret**.
2. **`AUTOFIX_TOKEN`** - a token the auto-fix workflow uses to push its branch and open the pull
   request. It is needed because pull requests opened with the built-in workflow token do not
   start other workflows, so they would get no build and no review.
   - Your profile picture > **Settings > Developer settings > Personal access tokens >
     Fine-grained tokens > Generate new token**.
   - Repository access: **Only select repositories** > your new repository.
   - Repository permissions: **Contents**, **Pull requests**, **Issues** = Read and write.
   - Copy the token and save it as repository secret `AUTOFIX_TOKEN` (same page as in 1).

## Step 4 - Repository settings

1. **Actions** tab > if asked, enable workflows. Then **Setup labels > Run workflow** (once).
   It creates the labels `claude-autofix`, `claude-in-progress`, `claude-pr-open`,
   `claude-needs-human` and `claude-fixup-done`.
2. Come back to the ruleset after step 5 (the check names only appear once they have run):
   **Settings > Rules > Rulesets > New ruleset > New branch ruleset**
   - Name `main`, Enforcement status **Active**, Target branches **Include default branch**.
   - Tick **Require a pull request before merging** (required approvals: 0).
   - Tick **Require status checks to pass** and add `build` and `claude_review`.
   - Create.

   With this in place nobody can merge a pull request that the build or the Claude review blocks.

## Step 5 - See the PR review

`docs/flawed-change.patch` is a small change with two deliberate problems: a debug endpoint that
can read any file on the server, and a money calculation in floating point without tests.

```
git checkout -b demo/flawed-change
git apply docs/flawed-change.patch
git commit -am "Add cache debug endpoint and tax sanity check"
git push -u origin demo/flawed-change
```

Open the pull request GitHub offers for the branch, then watch the **Actions** tab:

1. `build` runs lint and tests. They pass; the problems are not the kind a test catches.
2. `claude_review` reads the diff and the surrounding code.
3. On the pull request you get a summary comment, inline comments on the offending lines and a
   red `claude_review` check. With the ruleset from step 4 the Merge button is blocked.

Optional: fix one finding, push again and watch the review run again without repeating the
comments it already posted. Close the pull request when you are done.

Now create the ruleset from step 4.2.

## Step 6 - See the bug auto-fix

1. **Issues > New issue > Bug report.** Describe one wrong value you saw in step 2, in your own
   words (or copy one from `docs/PLANTED-BUGS.md`).
2. Add the label **`claude-autofix`** to the issue. Only people with write access can add labels,
   so outsiders cannot spend your API budget.
3. **Actions > Bug auto-fix** starts within seconds. Three jobs:
   - **Select work** claims the issue (label `claude-in-progress`).
   - **Reproduce and fix with Claude** writes a test that fails because of the bug, then fixes
     the code, then re-runs lint and all tests. This takes a few minutes.
   - **Open pull request or hand over** opens the pull request `autofix/issue-<n>` and comments
     on the issue.
4. Open the pull request. It lists the root cause, the changed files and the tests that failed
   before the fix. The normal `build` and `claude_review` checks run on it like on any other
   pull request.
5. Read the diff. If you agree, **Merge**. The issue closes automatically.
6. `git checkout main && git pull`, restart uvicorn and open the sample again: the value is correct.

## Step 7 - See the handover

Not every report can be fixed automatically, and the workflow is built to stop rather than guess.
Open an issue with the title "Extraction feels wrong" and no details, and label it `claude-autofix`.
Result: no pull request; the issue gets the label `claude-needs-human` and a comment saying where
it stopped and what a person needs to clarify. Removing that label lets the automation try again.

## Optional settings

| Setting | Where | Effect |
|---|---|---|
| `AUTOFIX_MAX_RUNS` | Settings > Secrets and variables > Actions > Variables | Total number of issues the automation may process. Use it as a hard cost cap |
| `AUTOFIX_BUDGET_USD`, `REVIEW_BUDGET_USD` | Variables | Spend limit per bug (default 5) and per review (default 2) |
| `AUTOFIX_MODEL`, `REVIEW_MODEL` | Variables | Default `claude-opus-5-5` for fixing, `claude-sonnet-5-5` for reviewing |
| `REVIEW_FAIL_ON` | Variables | Severities that block a merge, default `critical,high` |
| `AUTOFIX_HANDOVER_TO` | Variables | GitHub login that gets handed-over issues assigned |
| Auto-merge | Settings > General > Allow auto-merge, plus 1 required approval in the ruleset | Auto-fix pull requests then merge by themselves after a person approves. Needs a second account or a GitHub App as `AUTOFIX_TOKEN`, because you cannot approve a pull request opened with your own token |
| `REPO_URL` | Environment variable when starting uvicorn, e.g. `https://github.com/<you>/<repo>` | Adds a "Report a bug" button to the page |
| Pause the automation | Actions > Bug auto-fix > ... > Disable workflow | Stops the 5-minute schedule and the label trigger |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `claude_review` fails in the first step | `ANTHROPIC_API_KEY` is missing, or the pull request comes from a fork (forks get no secrets). Push the branch to the repository itself |
| Review fails with "401" or "authentication" | The API key is wrong or expired |
| Auto-fix pull request shows no checks | `AUTOFIX_TOKEN` is missing or expired; the run log has a warning. Add it, close the pull request, remove `claude-pr-open` from the issue and label it again |
| Auto-fix run ends with "Resource not accessible" when opening the pull request | Same cause: no `AUTOFIX_TOKEN`, and Actions is not allowed to create pull requests |
| Nothing starts after labelling | Label typo, labels not created (step 4.1), workflow disabled, or `AUTOFIX_MAX_RUNS` reached |
| Issue stays on `claude-in-progress` | A run was cancelled midway. Remove the label; the next run picks it up |
| Scheduled runs stopped | GitHub disables schedules in repositories without activity for 60 days. Re-enable the workflow |

## How it stays safe

- The bug report is untrusted text. It is passed to Claude as data, and the job that runs Claude
  has no token that can write to the repository.
- Only a patch leaves that job. A second job applies it to a clean checkout and rejects it unless
  it only touches `app/` and `tests/`, stays under 300 changed lines and leaves existing tests intact.
- Nothing merges without a person: the auto-fix opens a pull request, and the same build and
  review gates apply to it.
