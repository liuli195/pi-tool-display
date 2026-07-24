# Spec: Visual Preview and Configuration Lifecycle Corrections

> Status: Ready for implementation
>
> Scope: Complete the surviving upstream feedback work without violating the pure-display rendering contract.

## Problem Statement

Users expect compact tool previews to occupy a predictable amount of terminal space. Today non-Diff previews still mix logical-line preprocessing with visual-row limiting, so wrapped output can report the wrong omission count or bypass the intended budget. Some paths also emit logical-line omission hints even though users care about the terminal rows hidden from view.

Project-local configuration and renderer lifecycle behavior are also incomplete. A read-only project overlay can leak into global configuration writes, nested custom-tool settings can be reset by partial overlays, and disabling the extension does not reliably dispose every installed display patch. Runtime support declarations additionally disagree with the versions accepted by the Pi Host Adapter.

These gaps mean the four surviving upstream feedback categories cannot yet be considered complete: visual preview budgeting, Bash spinner removal, supported Pi compatibility, and trusted project-local configuration.

## Solution

All non-Diff previews will pass complete display text to one final visual-preview component. That component will render at the actual terminal width, apply a visual-row body budget, and append at most one omission hint reporting omitted visual rows. The hint is outside the body budget and occupies one additional row.

Diff remains the exception: its body budget is expressed in logical Diff lines. After those logical Diff lines are selected and rendered, the omission hint reports the visual Diff rows omitted by the logical selection.

Configuration updates will be explicit patches rather than reconstructed differences from an effective merged configuration. Trusted project configuration remains a read-only overlay and can never be persisted through global commands. Nested custom-tool overrides will merge field-by-field. Every installed Host Adapter, Resolver registration, and native user-message patch will expose and use an owned disposer so `enabled:false`, reload, shutdown, and project/session transitions restore native rendering.

The package peer range, Host Adapter runtime gate, documentation, and runtime matrix will describe one consistent support contract. Removed Bash animation timers remain removed.

## User Stories

1. As a Pi user, I want `previewLines` to limit terminal rows rather than newline-delimited source lines, so that a single long line cannot fill the viewport.
2. As a Pi user, I want Bash success previews to use a visual-row budget, so that wrapped output remains compact.
3. As a Pi user, I want Bash error previews to use the same visual-row contract, so that failures remain readable without flooding the viewport.
4. As a Pi user, I want partial Bash output to use the same budget as completed output, so that a running command does not expand unpredictably.
5. As a Pi user, I want Read previews to respect terminal wrapping, so that long file lines remain bounded.
6. As a Pi user, I want Grep, Find, and Ls previews to respect terminal wrapping, so that search results remain compact at narrow widths.
7. As a Pi user, I want MCP and custom-tool previews to respect terminal wrapping, so that third-party output follows the same display policy.
8. As a Pi user, I want expanded preview caps to count visual rows, so that expansion remains safe for very large output.
9. As a Pi user, I want folded non-Diff previews to show one omission hint, so that truncation information is clear rather than duplicated.
10. As a Pi user, I want the omission hint to report omitted visual rows, so that its number matches what the terminal would otherwise display.
11. As a Pi user, I want the omission hint outside the body budget, so that a budget of one still displays one body row.
12. As a Pi user, I want singular and plural hint wording to be correct, so that one omitted row is not described as multiple rows.
13. As a Pi user, I want narrow panes to retain an understandable omission marker, so that truncation is not silently hidden.
14. As a Pi user, I want empty successful output to continue showing `(no output)`, so that an empty renderer is distinguishable from missing UI.
15. As a Pi user, I want Diff folding to continue counting logical Diff lines, so that wrapping does not change which source changes are selected.
16. As a Pi user, I want a folded Diff hint to report the visual Diff rows omitted by the logical selection, so that I understand the viewport impact of hidden Diff content.
17. As a Pi user, I want collapsed and expanded Diff modes to share the logical Diff-line contract, so that expansion caps are predictable.
18. As a Pi user, I want tool-supplied truncation metadata to remain visible separately from display omission, so that display folding does not imply the tool returned complete data.
19. As a Pi user, I want project-local configuration to override global display settings only in that trusted project, so that teams can share presentation preferences safely.
20. As a Pi user, I want untrusted projects ignored, so that repository files cannot silently alter extension behavior.
21. As a Pi user, I want global commands to persist only fields I explicitly changed, so that a project overlay never leaks into global configuration.
22. As a Pi user, I want global presets and resets to remain complete under a project overlay, so that project values do not suppress intended global writes.
23. As a Pi user, I want a partial custom-tool project override to preserve its global sibling fields, so that changing output mode does not enable or reclassify the tool.
24. As a Pi user, I want `enabled:false` to restore native rendering immediately, so that disabling the extension is reversible.
25. As a Pi user, I want switching projects or sessions not to retain stale renderers, so that one project's configuration cannot affect another.
26. As a Pi user, I want reload and shutdown to restore exactly the patches owned by this installation, so that repeated lifecycle transitions do not stack wrappers.
27. As a Pi user, I want unsupported Pi runtimes to fall back to native rendering, so that display compatibility cannot affect tool execution.
28. As a Pi user, I want package installation claims to match runtime behavior, so that a peer-compatible Pi release is not unexpectedly rejected by the Host Adapter.
29. As a Pi user, I want Bash history rows not to animate on timers, so that scrolling does not jump or flicker.
30. As a maintainer, I want one visual-preview seam for all non-Diff tools, so that budgeting and hint behavior cannot diverge by renderer.
31. As a maintainer, I want complete source text passed to the visual-preview seam, so that omitted visual-row counts are exact.
32. As a maintainer, I want Diff budgeting isolated from generic preview budgeting, so that its logical-line exception remains explicit.
33. As a maintainer, I want configuration commands to submit patches, so that persistence does not infer intent from merged state.
34. As a maintainer, I want each display installation to own a disposer, so that lifecycle cleanup is directly testable.
35. As a maintainer, I want visual behavior tested through final component rendering, so that tests exercise real wrapping rather than helper internals.
36. As a maintainer, I want real-runtime contracts to run for every declared support target, so that skipped environments are not reported as passing.
37. As a maintainer, I want documentation and the upstream survivor audit to reflect verified behavior, so that completed and remaining work are accurately reported.
38. As a maintainer, I want the extension to remain a pure display wrapper, so that none of these corrections alter tools, Agent context, messages, execution, results, or session bytes.

## Implementation Decisions

1. The final component render boundary is the sole non-Diff visual-budget seam.
2. Non-Diff callers provide complete sanitized display text and never pre-slice it with a logical-line helper.
3. A preview body budget counts only rendered body rows. An omission hint, when needed, is appended as one additional row.
4. Collapsed non-Diff hints use the form `N more visual line(s) • Ctrl+O to expand` and occur at most once.
5. Expanded non-Diff caps report the actual omitted visual-row count and use consistent visual-row terminology.
6. Tool/backend truncation metadata is a separate informational hint and is not folded into the display omission count.
7. Extremely narrow widths use a width-safe abbreviated omission marker rather than emitting over-width text or silently omitting the fact of truncation.
8. Diff body selection uses logical Diff-line identities in collapsed and expanded modes.
9. Diff omission accounting renders the complete and selected logical Diff sets at the same width and reports the difference in visual Diff rows.
10. The Diff hint is outside the logical Diff body budget.
11. Empty-output behavior remains explicit and is not treated as truncation.
12. Project configuration is read only after trust confirmation and is retained separately from global configuration.
13. Configuration mutation accepts an explicit partial patch or explicit preset/reset operation; it does not infer user intent by comparing complete merged objects.
14. Nested built-in and custom-tool settings merge at their field level, preserving unspecified siblings.
15. Host Adapter installation, Resolver registration, and native user-message patch installation each return owned idempotent disposers.
16. The extension owns a per-session installation aggregate that is disposed on disablement, session transition, reload, shutdown, and replacement.
17. Disposal restores only descriptors still owned by the current installation and preserves later foreign patches.
18. The runtime support policy must be represented identically in peer dependencies, Host Adapter checks, runtime tests, README, and diagnostics.
19. Bash spinner and elapsed-time timers remain absent; no history-row interval invalidation is reintroduced.
20. All changes remain presentation-only and preserve original tool data, execution, Agent context, event ordering, and session serialization.

## Testing Decisions

1. Tests assert external behavior through final `Component.render(width)` output rather than private line-splitting helpers.
2. The primary preview seam covers Bash success/error/partial, Read, Search, MCP, and Custom renderers with the same worked examples.
3. Width coverage includes 1, 2, 5, 10, 20, 40, 80, 120, and a very wide terminal.
4. Content coverage includes empty output, multiple short logical lines, one extremely long logical line, mixed wrapped and unwrapped lines, ANSI, Unicode, CJK, and emoji.
5. Budget coverage includes zero where supported, one, two, defaults, small expanded caps, and unlimited expanded mode.
6. Tests assert exact body-row count, exact omitted visual-row number, a single display omission hint, and width-safe output.
7. Diff tests assert logical Diff body selection independently from the visual Diff-row omission number at multiple widths.
8. Tool-provided truncation metadata is tested independently from display omission hints.
9. Configuration tests use the public command/modal update seam and verify persisted global JSON plus effective merged behavior.
10. Configuration cases include trusted and untrusted projects, one-field edits, presets, resets, nested custom-tool fields, project transitions, and fresh sessions.
11. Lifecycle tests observe the host renderer before installation, while enabled, and after disable/disposal; they do not assert internal cleanup arrays.
12. Real-runtime contracts cover development and every declared supported release and must fail clearly when required runtime roots are unavailable in qualification runs.
13. Existing pure-display byte-invariance and no-tool-registration tests remain mandatory.
14. Each behavior is implemented with a red-green vertical slice, followed by typechecking and the relevant single test file.
15. Final qualification includes the full suite, build, diff check, runtime matrix, and parallel Standards and Spec reviews.

## Out of Scope

- Changing tool execution, ownership, arguments, results, Agent context, messages, or session content.
- Reintroducing Bash spinner animation or elapsed-time polling.
- Adding project-local write commands; project configuration remains read-only.
- Supporting historical Pi releases below the explicitly selected support floor unless separately qualified.
- Reconstructing missing diffs or reading workspace files for presentation.
- Redesigning colors, Diff algorithms, presets, or unrelated modal behavior.
- Treating missing real-runtime environments as successful qualification.

## Further Notes

- The surviving upstream categories are #36 visual preview budgeting, #14/#19 Bash timer repainting, #20/#31 Pi compatibility, and PR #27 trusted project-local configuration.
- Spinner removal is implemented at the code level but still requires final regression qualification.
- The existing visual implementation is not a safe base to preserve wholesale: it pre-slices logical lines before the final visual component and therefore cannot compute exact omitted visual rows.
- The project currently has no domain glossary or ADR that supersedes the terminology in the pure-display rendering specification.
