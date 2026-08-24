# Domain Docs

This repository uses a single-context domain-doc layout.

## Before exploring

Read:

- `CONTEXT.md` at the repository root
- Relevant ADRs under `docs/adr/`

If these files do not exist, proceed silently. Domain-modeling workflows create them when terminology or architectural decisions are actually resolved.

## File structure

```
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Vocabulary

Use domain terms exactly as defined in `CONTEXT.md`. Do not silently introduce synonyms that conflict with its glossary.

If a necessary concept is absent, reconsider whether the term belongs in the project or record the gap for domain modeling.

## ADR conflicts

If proposed work conflicts with an existing ADR, surface the contradiction explicitly instead of silently overriding the decision.
