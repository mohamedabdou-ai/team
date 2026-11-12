<!-- Team for Claude Code · Copyright 2026 Mohammed Abdo · Apache-2.0 · https://github.com/Engmohammedabdo/team -->
## Step: review your teammate's work (round {{ROUND}})

{{IMPLEMENTER}} implemented lane "{{LANE_ID}}" ({{LANE_TITLE}}) in this working directory, which is a separate git worktree.
See exactly what changed with: `git diff {{BASE}}..HEAD`
The specification and {{IMPLEMENTER}}'s latest report are attached.
{{PREVIOUS}}

Review for correctness bugs, conformance to the specification, missing pieces, broken edge cases, security problems, and tests. Run these checks if you can: {{VERIFY}}
Do not modify any file: this review is read-only.

If the automatic checks attached above FAILED, treat each failure as a finding.

Reply in {{LANGUAGE}}:
- One line per finding: `FINDING <n> [blocker|major|minor] <file:line>: <problem> → <fix>`, followed by an `Evidence:` line. Evidence is either `ran <command> → <what it printed>`, or `code "<exact text copied from that line>"`. The coordinator checks automatically that the file and line exist and that quoted code is really there; a blocker or major finding that fails this check does not count.
- Do not trust the implementer's report on its own: check the claims that matter (tests passing, behavior) against the code or by running the checks.
- Before giving any verdict, try to break the work: at least two concrete attacks (edge-case input, wrong order of actions, failure of a dependency, a case the spec mentions). One line each: `ATTACK: <what you tried> → <what happened>`. An approval without ATTACK lines is not accepted.
- Only blocker and major findings must be fixed before merging; minor ones are optional.
- The last line must be exactly one of these, in English:
VERDICT: APPROVE
VERDICT: CHANGES_REQUESTED
