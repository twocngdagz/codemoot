# Domain Docs

CodeMoot is treated as a single domain context shared by `core`, `cli`, and
`mcp-server`.

## Before exploring

Read these when they exist:

- `CONTEXT.md` at the repository root for canonical domain language.
- Relevant ADRs under `docs/adr/`.

If they do not yet exist, proceed silently. Domain documentation and ADRs are created
when terminology or architectural decisions are resolved; empty placeholders are not
required.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   └── agents/
└── packages/
    ├── core/
    ├── cli/
    ├── mcp-server/
    └── web/
```

Use the terminology defined in `CONTEXT.md` in issue titles, implementation plans,
tests, and documentation. Avoid introducing synonyms for established domain concepts.

If proposed work conflicts with an existing ADR, identify the conflict explicitly
rather than silently overriding the decision.
