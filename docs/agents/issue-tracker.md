# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues at `waibiwaibig/send-wechat`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`
- **Comment**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Publishing and fetching tickets

When a skill says “publish to the issue tracker,” create a GitHub issue.

When a skill says “fetch the relevant ticket,” run:

`gh issue view <number> --comments`

## Wayfinding operations

The map is one issue labelled `wayfinder:map`; its child issues are individual tickets.

- Child labels use `wayfinder:<type>`, where type is `research`, `prototype`, `grilling`, or `task`.
- Represent blocking relationships with GitHub native issue dependencies.
- If native sub-issues or dependencies are unavailable, record the relationship in the issue body.
- Claim a ticket with `gh issue edit <number> --add-assignee @me`.
- Resolve it by commenting with the result and closing the issue.
