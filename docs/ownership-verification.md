# Pure display verification

The extension changes only TUI rendering. It must not register or replace tools, mutate tool definitions or execution callbacks, change active tool ownership, alter model-visible context, or rewrite serialized session data.

## Automated verification

```sh
npx tsx --test tests/index-integration.test.ts tests/renderer-adapter-registration.test.ts tests/real-runtime-contract.test.ts
```

`index-integration.test.ts` verifies zero tool registrations across initialization, session lifecycle events, and configuration changes. `renderer-adapter-registration.test.ts` verifies producer adapters select display renderers without mutating tool definitions. `real-runtime-contract.test.ts` compares extension-present and extension-absent behavior against every required runtime in `tests/runtime-matrix.json`, including cold start, reload, new calls, ownership, execution, model-visible input, and session serialization.

Supply all required runtime package roots when running the contract matrix:

```sh
PI_RUNTIME_DEV_ROOT=/path/to/development/pi-coding-agent \
PI_RUNTIME_0_81_1_ROOT=/path/to/pi-coding-agent-0.81.1 \
PI_RUNTIME_MIN_ROOT=/path/to/minimum-supported/pi-coding-agent \
npm test
```

Complete verification also requires:

```sh
npm run typecheck
npm run build
git diff --check
```
