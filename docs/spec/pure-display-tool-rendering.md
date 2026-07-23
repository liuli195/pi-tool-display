# Spec: Pure Display Tool Rendering

> Status: Approved direction; implementation pending
>
> Scope: Refactor `pi-tool-display` into a pure TUI display wrapper and tool beautifier.

## Problem Statement

Users configure `pi-tool-display` so built-in and third-party tool calls remain compact, readable, and consistently folded. Today that expectation is not met across the full Pi lifecycle:

- restored historical tool rows can ignore the configured renderer on cold startup;
- `/reload` can restore some rows only after another UI action while leaving tools such as `grep` on Pi's native renderer;
- historical and newly executed calls can render differently despite having the same tool data and configuration;
- the current built-in path obtains display control by re-registering tools, copying tool definitions, wrapping execution, tracking ownership, and retaining execution metadata;
- the thinking-label feature mutates assistant messages and later sanitizes model context;
- projected write diffs can read or retain information that the tool itself did not provide.

From the user's perspective, this is both unreliable and broader than the product should be. A display extension must not change which tools the Agent sees, how tools execute, what context the model receives, or what is stored in the session merely to control TUI presentation.

The product contract is therefore:

1. Built-in and explicitly configured third-party tools render and fold according to the current display configuration.
2. Cold startup, `/reload`, restored history, new calls, partial calls, and Ctrl+O use the same display policy.
3. The extension changes only TUI presentation. Agent behavior, tool behavior, context, messages, and session content remain unchanged.
4. Diff rendering uses only trustworthy information already supplied by the tool call or result. The extension never reads or saves an unprovided preimage and never guesses a diff.

## Solution

`pi-tool-display` will use one display seam: Pi's final tool-row renderer selection. A pure Tool Display Resolver will choose call, result, and shell presentation from the current immutable configuration and the tool row's original data. A version-aware Pi Host Adapter will be the only module that knows about Pi's private TUI shape.

The extension will stop re-registering built-in tools for display purposes. It will not wrap `execute`, clone schemas or prompt metadata, change ownership, activate tools, mutate ToolDefinition objects, or write presentation metadata into messages or sessions.

A Renderer Catalog will retain the existing read, search, Bash, edit, write, MCP, generic, and diff presentation behavior where that behavior can be derived from original tool information. Built-in display rules will work regardless of which extension owns the executable tool. Explicit third-party rules will continue to support hidden, summary, and preview result modes, with call replacement controlled by configuration.

Diff behavior will follow a strict trust rule:

- an explicit diff or patch supplied by the tool may be reformatted, highlighted, and folded;
- explicit before/after data supplied by the tool, such as edit old/new text, may be rendered as a diff;
- new write content may be summarized or previewed as content;
- absent trustworthy before/after information, no diff is synthesized;
- the renderer will never read the workspace to reconstruct a preimage, retain an execution preimage, mark all new content as additions, or compare against the current post-execution file.

The thinking-label feature will be removed. Existing sessions and user configuration will not be rewritten merely to clean up historical labels or obsolete settings.

If the Pi Host Adapter does not recognize a runtime shape or a configured renderer fails, it will fail open to Pi's original renderer. It must never fall back to tool re-registration. The local solution does not depend on an upstream Pi change; a future public Pi renderer interface is only the planned replacement for the private Host Adapter.

### Success criteria

- The configured display is correct on the first rendered frame after cold startup and `/reload`, without requiring Ctrl+O, theme changes, or another tool call.
- Built-in and configured third-party tools follow the same display policy for historical and new rows.
- Enabling the extension changes only TUI output when compared with an otherwise identical deterministic session.
- Tool registry, active tools, ownership, definitions, execution, model input, events, results, and session serialization are unchanged.
- No diff is shown unless its before/after semantics are supported by original tool data.
- Unsupported Pi runtimes continue to execute normally with native rendering.

## User Stories

1. As a Pi user, I want restored `read` calls to follow my configured display mode, so that reopening a session does not make old output noisy again.
2. As a Pi user, I want restored `grep` calls to follow my configured count, preview, or hidden mode, so that search output is consistent with my settings.
3. As a Pi user, I want restored `find` calls to use my configured folding behavior, so that inactive-at-startup tools do not render differently from active tools.
4. As a Pi user, I want restored `ls` calls to use my configured folding behavior, so that historical directory listings remain compact.
5. As a Pi user, I want restored Bash calls and results to use my command, success-output, and error-output settings, so that old terminal output does not dominate the session.
6. As a Pi user, I want restored edit calls to retain configured diff styling and folding, so that file changes remain readable after reopening the session.
7. As a Pi user, I want restored write calls to show only trustworthy summaries, previews, or supplied diffs, so that the UI never invents a file change.
8. As a Pi user, I want explicitly configured third-party tools to use hidden, summary, or preview modes, so that extension tools are as manageable as built-in tools.
9. As a Pi user, I want configured MCP proxy and direct tools to use the selected MCP presentation, so that verbose protocol output stays compact.
10. As a Pi user, I want tools without a matching display rule to keep their native presentation, so that the extension does not unexpectedly restyle unrelated tools.
11. As a Pi user, I want a configured call renderer override to affect only presentation, so that the underlying third-party tool remains unchanged.
12. As a Pi user, I want Ctrl+O to expand and collapse both historical and new tool rows consistently, so that one shortcut controls the whole session.
13. As a Pi user, I want the first cold-start frame to use my configuration, so that I do not need to run `/reload` after every launch.
14. As a Pi user, I want the first frame after `/reload` to use my configuration, so that I do not need another UI action to repair stale rows.
15. As a Pi user, I want a newly executed tool and an equivalent historical tool to look the same, so that rendering does not depend on when the row was created.
16. As a Pi user, I want partial and streaming Bash output to remain responsive and folded according to configuration, so that long-running commands stay readable.
17. As a Pi user, I want failed tool calls to retain visible failure information while respecting error folding settings, so that compact output does not hide errors.
18. As a Pi user, I want aborted calls to remain identifiable, so that display customization does not obscure execution state.
19. As a Pi user, I want image-bearing tool results to retain their images and text behavior, so that display customization does not lose result content.
20. As a Pi user, I want truncation information supplied by tools to remain visible when configured, so that compact output does not imply completeness incorrectly.
21. As a Pi user, I want changing a display setting to affect presentation rather than tool ownership, so that configuration has no execution consequence.
22. As a Pi user, I want disabling the extension to restore Pi's original rendering, so that the extension is reversible.
23. As a Pi user, I want an unsupported Pi version to fall back to native display, so that a presentation incompatibility cannot break my tools.
24. As a Pi user, I want renderer errors to fall back to the original renderer, so that malformed or old result data remains usable.
25. As a Pi user, I want the same tools to remain available with or without the extension, so that display configuration cannot activate or remove tools.
26. As a Pi user, I want third-party tool ownership to remain unchanged, so that extension load order cannot redirect tool execution.
27. As a Pi user, I want tool arguments and results to remain unchanged, so that display formatting cannot alter what a tool receives or returns.
28. As a Pi user, I want system prompts and model-visible tool schemas to remain unchanged, so that installing a display extension cannot change Agent decisions.
29. As a Pi user, I want session JSONL content to remain unchanged, so that display labels and metadata do not pollute session history.
30. As a Pi user, I want reload and shutdown to leave no stale display patch or renderer state, so that repeated reloads do not compound behavior.
31. As a Pi user, I want the extension not to retain file preimages or execution metadata, so that display cannot leak or stale-cache workspace content.
32. As a Pi user, I want an explicit tool-provided diff to use the configured layout, colors, indicators, and collapse limit, so that trustworthy diffs remain easy to review.
33. As a Pi user, I want edit old/new text supplied in the call to be rendered as a diff, so that the extension can improve information the tool already provided.
34. As a Pi user, I want a write call with only new content to display a neutral summary or preview rather than a fabricated diff, so that overwrite and creation semantics are not guessed.
35. As a Pi user, I want a tool result without diff information to remain truthful, so that visual additions and deletions always have evidence.
36. As a Pi user, I want historical write rows not to compare against the current filesystem, so that later file changes cannot rewrite the apparent history.
37. As a Pi user, I want missing diff information to stay missing rather than trigger workspace reads, so that rendering remains observational.
38. As a Pi user, I want thinking content to remain exactly as Pi produced it, so that presentation code never mutates assistant messages.
39. As a Pi user, I want obsolete thinking-label configuration to be ignored without rewriting my config or sessions, so that removing the feature causes no content migration.
40. As a Pi user, I want the native user-message box and other presentation-only features to continue working, so that the pure-display scope does not remove legitimate TUI improvements.
41. As a third-party tool author, I want my ToolDefinition and `execute` implementation to remain untouched, so that adopting `pi-tool-display` cannot change my tool contract.
42. As a third-party tool author, I want to register a display Adapter without depending on extension load order, so that my tool can opt into specialized presentation safely.
43. As a third-party tool author, I want Adapter registration to be disposable and deterministic, so that reload does not leave duplicate or stale display rules.
44. As a third-party tool author, I want conflicting display rules to fail safely rather than depend silently on last registration order, so that presentation ownership is diagnosable.
45. As a maintainer, I want all Pi-private TUI knowledge localized in one Host Adapter, so that a Pi upgrade requires changes in one place.
46. As a maintainer, I want rendering policy behind a small Resolver interface, so that built-in, custom, MCP, historical, and new rows share one implementation.
47. As a maintainer, I want the Resolver to be synchronous and deterministic for a configuration snapshot, so that rendering does not depend on lifecycle timing.
48. As a maintainer, I want display rules to avoid registry scans on every render, so that large historical sessions remain responsive.
49. As a maintainer, I want one real-runtime test seam to cover cold startup, reload, and new calls, so that mock tests cannot hide lifecycle regressions.
50. As a maintainer, I want byte-level non-interference tests for Agent and session data, so that future display features cannot silently cross the product scope.
51. As a maintainer, I want tests to assert the first rendered state before manual expansion or invalidation, so that refresh actions cannot create false positives.
52. As a maintainer, I want a clean rollback commit, so that the new display seam can be reverted without undoing the diagnostic tests.
53. As a maintainer, I want legacy ownership-named configuration to migrate without changing tool ownership, so that existing users keep their intended display choices.
54. As a maintainer, I want the local implementation to work without an upstream Pi patch, so that delivery is controlled by this repository.

## Implementation Decisions

1. **Product scope is pure TUI presentation.** The extension may read immutable configuration and original tool-row data and may return TUI display objects. It must not change Agent, tool, context, message, or session behavior.

2. **Use a single display seam.** The highest practical seam is the final renderer selection for a Pi tool row. Built-in, third-party, MCP, historical, and new rows will all pass through this seam.

3. **Build a deep Tool Display Resolver module.** Its interface accepts a read-only row descriptor plus native renderer slots and returns a display plan. Its implementation hides configuration policy, tool classification, Renderer Adapter selection, slot precedence, error isolation, and native fallback.

4. **Keep the Resolver interface small.** The primary operation is display-plan resolution. Renderer Adapter registration is the only extension operation and returns a disposable registration. Disposal is part of lifecycle ownership rather than a separate global cleanup protocol.

5. **Use a Renderer Catalog behind the Resolver.** Existing read, search, Bash, edit, write, diff, MCP, and generic rendering implementations will be retained where they satisfy the pure-display invariant. The catalog is internal implementation, not another public seam.

6. **Localize Pi-private coupling in one Pi Host Adapter.** Only this Adapter may inspect or wrap Pi's private tool-row renderer-selection shape. It translates host rows into stable read-only descriptors, invokes the Resolver, and returns native renderers when unsupported or unsuccessful.

7. **Install the Host Adapter transactionally.** Required host methods and fields must pass shape checks before any patch is installed. Partial installation is forbidden. Installation is idempotent and tagged with an owner token.

8. **Restore exact host descriptors on disposal.** Reload and shutdown restore only methods still owned by the current installation. Foreign patches installed later are not deleted or overwritten.

9. **Fail open to native rendering.** Unsupported Pi versions, shape mismatches, Resolver failures, Adapter conflicts, and renderer failures must preserve Pi's native display. They must never trigger tool re-registration as a fallback.

10. **Do not use tool registration for display.** The extension will not call `registerTool` for built-in display overrides and will not call active-tool mutation interfaces.

11. **Do not replace or decorate executable definitions.** ToolDefinition identity, property descriptors, label, description, schema, prompt metadata, argument preparation, execution function, ownership, and source information remain unchanged.

12. **Do not wrap execution.** Tool calls, signals, update callbacks, working directories, results, details, errors, and event ordering pass directly between Pi and the original tool.

13. **Remove execution-coupled state.** Built-in tool caches, runtime ownership publication, execution metadata maps, preimage maps, registration sets, and descriptor-restoration machinery used for ToolDefinition mutation will be removed.

14. **Allow only display-local transient state.** Pi-provided row state, previously returned TUI objects, and animation state may be used only to render that row. They must not retain file preimages, alter tool semantics, enter Agent/session data, or survive disposal.

15. **Resolve display independently of execution ownership.** A display rule changes presentation regardless of whether the executable tool is built in, SDK-provided, or extension-provided. It never changes that ownership.

16. **Preserve native behavior when no display rule matches.** An unconfigured tool inherits its original call renderer, result renderer, and shell behavior.

17. **Apply explicit custom rules deterministically.** A configured third-party rule controls only its declared display slots. Native call rendering remains unless call replacement is explicitly enabled. Result hidden, summary, and preview modes follow configuration.

18. **Treat MCP as a display strategy, not execution provenance.** Explicit MCP configuration or a producer-provided Renderer Adapter may select MCP presentation. Heuristics may support diagnostics but cannot silently change presentation.

19. **Resolve call, result, and shell policy coherently.** A row's display plan must not combine incompatible primary Adapters merely because Pi asks for slots separately. Unspecified slots inherit native behavior.

20. **Use deterministic Adapter ordering.** Explicit user rules outrank producer registrations and built-in defaults. Equal-priority conflicting primary Adapters fail open and emit one diagnostic rather than relying on load order.

21. **Keep rendering synchronous.** Display-plan selection performs in-memory lookups against an immutable effective configuration snapshot. It does not scan the tool registry, await lifecycle events, or perform filesystem access.

22. **Make configuration changes presentation-only.** The existing ownership-named built-in settings are treated as display switches during compatibility migration. They no longer imply tool ownership or require ownership re-registration.

23. **Introduce display-oriented configuration terminology.** A canonical built-in display setting replaces ownership terminology. Legacy `registerToolOverrides` values are accepted as input and mapped to the display setting. Merely loading legacy configuration does not rewrite the user's file.

24. **Retain existing custom-tool configuration semantics.** Explicit custom overrides continue to support enablement, generic or MCP display kind, output mode, and optional call renderer replacement.

25. **Do not synthesize diff evidence.** A renderer may display an explicit tool-provided diff or patch, or derive a diff from explicit before/after fields supplied by the tool. It cannot read the workspace to obtain missing state, retain a preimage, infer creation versus overwrite, or compare with a later file state.

26. **Render writes truthfully.** A write with only path and new content may show a path, line count, byte count, neutral content preview, original result text, and configured folding. It cannot show red/green changes without trustworthy before/after information.

27. **Remove projected write diffs that require workspace state.** Pending overwrite/create classification and previews that depend on reading an existing file are removed. Pending write calls may use neutral summaries or previews derived from call arguments.

28. **Render edits only from supplied evidence.** Explicit old/new edit text, structured patches, or result diffs may be styled and folded. The extension does not read a file to validate, complete, or expand missing edit information.

29. **Never rewrite historical presentation.** Historical rows use only their stored original call/result data. The extension will not consult current files to reconstruct past diffs and will not modify session history to add display metadata.

30. **Remove thinking labels.** Message-update, message-end, and context handlers used to prefix or sanitize thinking content are removed. Historical labels already stored in sessions are left untouched.

31. **Remove the thinking-label setting.** Legacy values are ignored during normalization without automatic file rewriting. The setting is removed from defaults, presets, commands, modal content, examples, and active documentation.

32. **Keep legitimate display-only features.** The native user-message box and other features that only change TUI objects remain in scope, subject to the same non-interference tests.

33. **Migrate the consumer interface to Renderer Adapter registration.** The display consumer no longer mutates or clones ToolDefinition objects. A compatibility facade may accept the previous call shape for one migration period, but it registers display intent and returns the original tool unchanged.

34. **Do not require Pi upstream work.** The private Host Adapter is the local compatibility implementation. A future public renderer registry or refresh interface replaces only that Adapter; the Resolver and Renderer Catalog remain unchanged.

35. **Support explicitly verified Pi runtimes.** Runtime support requires both a tested version and passing shape checks. An unverified runtime uses native rendering and a concise compatibility diagnostic rather than risking execution behavior.

36. **Update product language.** Documentation, configuration help, changelog entries, and diagnostics will describe display selection rather than ownership, tool overrides, or execution replacement.

37. **Replace rather than layer.** Characterization tests may compare old and new paths during development, but the released implementation contains one renderer-selection path. Old registration and mutation tests are removed once equivalent behavior is covered through the Resolver and real TUI seam.

## Testing Decisions

1. **Test at the highest practical seam.** The primary integration seam is a real Pi InteractiveMode tool row rendered through an in-memory terminal. This exercises host loading, historical restoration, renderer selection, folding, and output without calling a model or requiring manual input.

2. **Cover three lifecycle paths in the same harness.** Tests exercise cold restored history, the real `/reload` sequence, and new tool events. The first collapsed assertion occurs before Ctrl+O, theme invalidation, or manual `setExpanded` calls.

3. **Use real supported Pi versions.** Run the host integration contract against the repository development version, Pi 0.81.1, and any declared minimum supported version. Runtime package roots are supplied by the test environment rather than hard-coded to a user installation.

4. **Test the Tool Display Resolver through its interface.** Policy tests supply immutable row descriptors, native slots, configuration snapshots, and registered Adapters, then assert the resulting display plan or native fallback. Tests do not reach into internal maps.

5. **Test the Pi Host Adapter as an external-dependency Adapter.** Contract tests verify shape detection, argument and `this` forwarding, transactional installation, idempotence, owner-token behavior, exact descriptor restoration, foreign-patch preservation, and native fallback.

6. **Add byte-level non-interference tests.** Run equivalent deterministic sessions with the extension absent and present, and compare model-visible prompt/context, active tool names and order, tool schemas, tool ownership, call arguments, updates, results, event order, and session JSONL. Only in-memory TUI output may differ.

7. **Assert zero tool registration.** Extension initialization, cold startup, reload, and configuration changes must not register a tool or mutate active tools.

8. **Assert definition immutability.** Original ToolDefinition identities, property descriptors, renderer fields, execution functions, schemas, prompt metadata, and argument preparation remain identical before and after installation and disposal.

9. **Assert no workspace reads for diff synthesis.** Diff and pending-preview tests spy on filesystem access and verify that rendering uses only supplied call/result data. Configuration loading is tested separately and is not confused with tool-data reconstruction.

10. **Test trustworthy diff sources.** Cover explicit unified and structured diffs, patches in result details, edit old/new fields, missing before information, write content without preimage, malformed diff details, and renderer fallback.

11. **Test truthful write degradation.** Without supplied diff evidence, collapsed and expanded write rows show neutral summaries, content previews, or original result text and never show fabricated additions, deletions, create, or overwrite labels.

12. **Test all built-in display families.** Cover read, grep, find, ls, Bash, edit, and write across configured hidden, count, summary, preview, full, success, error, and applicable diff modes.

13. **Test third-party and MCP display.** Cover configured and unconfigured tools, native call renderer preservation, explicit call replacement, generic and MCP modes, producer Adapter registration, same-name tools, Adapter conflict, and late registration.

14. **Test row states.** Cover collapsed, expanded, partial, successful, failed, aborted, truncated, image-bearing, empty-output, and old-schema rows.

15. **Test reload lifecycle repeatedly.** Multiple reloads must not stack wrappers, duplicate animation timers, retain old Adapter registrations, or change final host descriptors after disposal.

16. **Test unsupported runtimes.** Missing or changed private host methods result in no partial patch, one compatibility diagnostic, native rendering, and unchanged tool execution.

17. **Test performance at realistic history size.** A session with at least 500 tool rows must not trigger registry scans, whole-chat rebuild loops, or O(n²) resolver work. Display selection is O(1) per row and slot.

18. **Test consumer compatibility at the public interface.** Legacy consumer calls, migration behavior, new disposable Adapter registration, duplicate registration, conflict handling, reload, and disposal are verified without ToolDefinition mutation.

19. **Test thinking-label removal.** The extension registers no message-update, message-end, or context handler for thinking labels; thinking content and serialized sessions remain byte-identical.

20. **Retain prior art where it tests user behavior.** Existing output-mode, Bash streaming/error, diff layout, custom tool, user-message-box, reload, and historical renderer tests remain useful when rewritten to cross the new interface. Tests whose success criterion is tool registration, ownership takeover, schema cloning, execute wrapping, or manual refresh are deleted rather than layered beneath the new design.

21. **Require normal project validation.** The full test suite, typecheck, build, diff check, and real-runtime smoke test must pass before review.

22. **Review along two axes.** Standards review verifies repository conventions and the pure-display architectural invariant. Spec review verifies every user-visible behavior and non-interference acceptance criterion in this document.

## Out of Scope

- Adding or changing Pi tool execution behavior.
- Activating, deactivating, replacing, or reordering tools.
- Modifying model prompts, context construction, Agent policy, or session serialization.
- Reconstructing a missing write preimage or historical diff.
- Reading current workspace files to infer past tool state.
- Cleaning thinking labels already stored in historical sessions.
- Rebuilding Pi's entire chat UI to force renderer changes.
- Depending on timers or delayed registration to guess lifecycle ordering.
- Implementing the proposed public renderer interface in upstream Pi.
- Guaranteeing customized display on unverified Pi private TUI shapes; native fallback is the supported behavior.
- Redesigning the visual language, presets, colors, or diff algorithms beyond changes required for truthful input handling.
- Changing the native user-message box unless non-interference testing identifies a violation.
- Persisting renderer state across sessions or reloads.
- Automatically rewriting user configuration merely because legacy keys are present.

## Further Notes

- The repository currently has no domain glossary or ADR for this area. The stable domain terms introduced by this spec are **Tool Display Resolver**, **Renderer Catalog**, **Renderer Adapter**, **Pi Host Adapter**, **display plan**, **native fallback**, and **trustworthy diff evidence**.
- The current research report remains authoritative for the observed Pi 0.81.1 lifecycle and existing test false positives. Its earlier refresh-pulse recommendation is superseded where it conflicts with this spec's pure-display architecture.
- The key architectural decision is that the semantically correct private display seam is preferable to the public tool-registration seam because tool registration cannot satisfy the product's non-interference invariant.
- The Pi Host Adapter is tactical and replaceable. The Tool Display Resolver and Renderer Catalog are the durable modules.
- Estimated implementation and verification cost is approximately 5–10 focused engineering days. Testing cost is expected to exceed renderer rewiring cost because private-host compatibility and byte-level non-interference require real-runtime coverage.
- Migration should be reviewable as separate commits: characterization and non-interference tests; pure Resolver and Host Adapter; built-in cutover and old-path deletion; diff truthfulness and thinking-label removal; consumer/config/documentation migration; real-runtime verification.
- Rollback should revert the production cutover without removing the new diagnostic and non-interference tests.
