# Main branch protection

STATUS: DRAFT — ruleset authored, not yet applied. The operator applies it out-of-band (a repo-admin GitHub state change); once applied, flip this to `STATUS: ACTIVE, last verified YYYY-MM-DD` and fill in the ruleset id below.

## Why this exists

CLAUDE.md makes two non-negotiable claims: **"`main` is always green"** and **"PRs are required to merge."** Until now those were enforced only by convention + the orchestration loop's own discipline — `main` had **no server-side protection** (`gh api repos/aswaratech/fleetco/branches/main/protection` → 404; `gh api repos/aswaratech/fleetco/rulesets` → `[]`). Nothing on the server stopped a direct push to `main`, a force-push, a branch deletion, or a merge of a red/unreviewed PR. With an autonomous loop holding merge authority (ADR-0022), a server-side backstop is a near-prerequisite before trusting the loop, and it makes the green-before-merge gate real rather than aspirational.

This procedure records the ruleset and how to apply/verify it. The ruleset is a GitHub **repository ruleset** (the modern replacement for classic branch protection).

## The ruleset

Requires: a PR to merge (no direct push), no force-push, no branch deletion, and all CI status checks green. `required_approving_review_count` is **0** because the CEO is the sole developer and the loop merges on green — a review-count > 0 would block solo/loop merges (there is no second account to approve). `bypass_actors` is empty (strictest; honors "main always green"); the operator may add themselves as a bypass actor if they want an emergency direct-push escape hatch.

```json
{
  "name": "main branch protection",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge", "squash", "rebase"]
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          { "context": "lint + format + typecheck + tests" },
          { "context": "driver app — lint + typecheck + test" },
          { "context": "docker build — api (no push)" },
          { "context": "docker build — web (no push)" },
          { "context": "validate prod compose + Caddyfile" },
          { "context": "semgrep (OWASP + security-audit)" },
          { "context": "Analyze (actions)" },
          { "context": "Analyze (javascript-typescript)" }
        ]
      }
    }
  ],
  "bypass_actors": []
}
```

### ⚠️ Re-pull the exact check names before applying — a wrong byte deadlocks every merge

A required-status-check `context` must match, byte-for-byte, the name GitHub reports on a PR. If a required context never appears (typo, renamed job, or a name that isn't actually reported), it stays permanently `Expected` and **no PR can ever merge**. Two hazards here:

- The two `Analyze (...)` contexts come from GitHub's **CodeQL default setup** (there is no workflow file for them), so they can only be read from live check-runs, not from `.github/workflows/`.
- Do **not** require `push image to GHCR + CycloneDX SBOM — …` — it is skipped on PRs (push-only), so requiring it would deadlock every PR.

Immediately before applying, re-pull the live names from a recent green PR head and confirm the eight above match exactly:

```sh
# the exact check-run contexts GitHub reported on a recent PR (adjust the PR number)
gh pr checks 169 --repo aswaratech/fleetco | awk -F '\t' '{print $1}' | sort -u
```

The em-dashes in `docker build — …`, `driver app — …`, and `validate prod compose + Caddyfile` are literal `—` (U+2014); copy them, don't retype.

## Apply (operator, repo-admin)

```sh
# write the JSON above to a file, then:
gh api --method POST repos/aswaratech/fleetco/rulesets --input /tmp/fleetco-main-ruleset.json
```

## Verify (after applying)

```sh
gh api repos/aswaratech/fleetco/rulesets                      # the ruleset is listed, enforcement: active
gh api repos/aswaratech/fleetco/rules/branches/main           # the rules apply to main
```

Then flip the STATUS line above to `ACTIVE` with today's date and record the returned ruleset id here:

- **Ruleset id:** _(fill in after apply)_

A functional check: open a throwaway PR with a trivial change and confirm it cannot be merged until the eight checks report green, and that a direct `git push origin main` is rejected.
