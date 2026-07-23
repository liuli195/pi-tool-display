# Tool ownership verification

Verified on 2026-07-23 with Node 24.15.0 on Windows. The CLI environment had Pi 0.81.1; the project's pinned test dependency was Pi 0.80.3.

## Automated smoke coverage

```sh
npx tsx --test tests/tool-overrides-registration.test.ts tests/reload-behavior.test.ts
# 37 passed, 0 failed
```

The focused tests simulate `pi-hashline-edit-pro` owning `read`/`edit` and
`pi-patty-bg-tasks` owning `bash`, including late registration, missing
`sourceInfo`/`source`, inactive `find`/`ls`, and an actual
`session_shutdown(reload) -> new extension instance -> session_start(reload)`
sequence. They also instantiate Pi's `ToolExecutionComponent` renderer
selection and assert that the installed Pi runtime awaits
`rebindCurrentSession()` (which emits `session_start`) before
`renderInitialMessages()` constructs restored-history rows.

The named third-party packages were not installed in this environment, so no
interactive package smoke test was claimed; their ownership behavior is
covered by deterministic ExtensionAPI simulations using the same tool names
and provenance shapes.

## Full verification

```sh
npm test            # 690 passed, 0 failed
npm run typecheck   # passed
npm run build       # passed
git diff --check    # passed
```
