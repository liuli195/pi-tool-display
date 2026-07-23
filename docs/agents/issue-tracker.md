# Issue tracker: GitHub

Issues and PRDs for this repo live in `liuli195/pi-tool-display` GitHub Issues. Use the `gh` CLI with `--repo liuli195/pi-tool-display`.

## Conventions

- **Create an issue**: `gh issue create --repo liuli195/pi-tool-display --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --repo liuli195/pi-tool-display --comments`
- **List issues**: `gh issue list --repo liuli195/pi-tool-display --state open`
- **Comment**: `gh issue comment <number> --repo liuli195/pi-tool-display --body "..."`
- **Apply/remove labels**: `gh issue edit <number> --repo liuli195/pi-tool-display --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo liuli195/pi-tool-display --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill operations

- When a skill says **publish to the issue tracker**, create a GitHub issue in `liuli195/pi-tool-display`.
- When a skill says **fetch the relevant ticket**, run `gh issue view <number> --repo liuli195/pi-tool-display --comments`.
