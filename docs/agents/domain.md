# Domain Docs

Engineering skills should use this repository’s domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repository root.
- Relevant ADRs under `docs/adr/`.

If these files do not exist, proceed silently. Create them lazily through the domain-modeling workflow when terminology or architectural decisions are resolved.

## Layout

This is a single-context repository:

```
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Vocabulary

Use terminology defined in `CONTEXT.md`. Avoid synonyms that the glossary explicitly rejects. If a required concept is absent, reconsider the terminology or record the gap for domain modeling.

## ADR conflicts

Explicitly identify output that contradicts an existing ADR instead of silently overriding it.
