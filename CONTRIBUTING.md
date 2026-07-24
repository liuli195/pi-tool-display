# Contributing

1. Fork the repository and create a branch from `main`.
2. Install dependencies with `npm ci`.
3. Make a focused change with tests where behavior changes.
4. Run:

```bash
python .build-and-verify/runtime/build_and_verify.py verify --project .
```

5. Open a pull request using the repository template.

Strict real-runtime qualification additionally requires the `PI_RUNTIME_*` paths documented in `README.md`.
