# Review-Workflow Configuration v3

Configuration v3 adds review-workflow identity, commit, and gate policy without changing the
legacy `plan-review-implement` workflow. Existing v1 and v2 `.cowork.yml` files are migrated
when loaded. The original file is retained as `.cowork.yml.bak` before the migrated document is
written atomically.

## Compatibility defaults

Migrated Codex-only configurations keep their existing models, roles, and workflow. They receive
the following dormant review-workflow defaults:

```yaml
configVersion: 3

reviewGated:
  identity:
    minimumAssurance: config_only
    requireDifferentAdapterKinds: false
    prohibitSharedSessions: true
  commit:
    mode: human_required
    agentMayCommit: false
  gates:
    planReview: required
    codeReview: required
    verification: required
    humanMerge: required
    blockingSeverities: [critical, high]
    requireAllFindingResponses: true
    requireAcceptedAttestations: true

debate:
  enabled: true
```

These settings preserve legacy behaviour. They are intentionally insufficient to activate
`review-gated-batches`: that workflow requires different configured agents, different adapter
kinds, shared-session prohibition, and at least `process_attested` identity assurance.

## Review-gated configuration

The existing `models` and `roles` sections remain the assignment interface. There is no second
agent hierarchy.

```yaml
configVersion: 3
workflow: review-gated-batches

models:
  claude-agent:
    provider: anthropic
    model: supported-claude-model
    cliAdapter:
      kind: claude
      command: claude
      args: []
      timeout: 600
      versionConstraint: supported-version-range

  codex-agent:
    provider: openai
    model: supported-codex-model
    cliAdapter:
      kind: codex
      command: codex
      args: [exec]
      timeout: 600
      versionConstraint: supported-version-range

roles:
  implementer:
    model: claude-agent
  reviewer:
    model: codex-agent

reviewGated:
  identity:
    minimumAssurance: process_attested
    requireDifferentAdapterKinds: true
    prohibitSharedSessions: true
  commit:
    mode: human_required
    agentMayCommit: false
  gates:
    planReview: required
    codeReview: required
    verification: required
    humanMerge: required
    blockingSeverities: [critical, high]
    requireAllFindingResponses: true
    requireAcceptedAttestations: true

debate:
  enabled: false
```

Provider and adapter kind must agree: `anthropic` uses `claude`, and `openai` uses `codex`.
Configuration v3 selects the concrete role bridge from `cliAdapter.kind`. Commands resolve the
configured role alias rather than assuming a `codex-*` model name, so implementer and reviewer
direction can be swapped without changing the role vocabulary.

## Identity assurance

The assurance levels, strongest first, are:

- `authenticated_subject`: the CLI exposes a stable subject identifier that can be stored as a
  hash.
- `cli_asserted`: CLI output asserts an identity that CodeMoot cannot independently authenticate.
- `process_attested`: CodeMoot observed executable, process, invocation, model, working directory,
  and session evidence, but not an authenticated account.
- `config_only`: only the configured assignment is known.

Runtime evaluation derives the effective level from the supplied evidence; changing the declared
level alone cannot strengthen it. `process_attested` requires adapter, executable, CLI version,
configured model, process, invocation, and session evidence. `cli_asserted` additionally requires
a `CLI_ASSERTED_IDENTITY` observation, while `authenticated_subject` requires hashed subject
evidence.

Configuration aliases are not proof of independent execution. Workflow start resolves immutable
implementer and reviewer assignment snapshots, configuration hash, commit policy, gate policy,
and independent authority grants. Runtime identity evaluation additionally requires distinct
execution and invocation identities and rejects shared session identity.

Role invocation persists the assignment, actual process invocation, actor execution, and vendor
session linkage. A session may only be resumed by its assigned role in the workflow that created
it and through the same adapter. The runtime also rejects a vendor session observed for the
opposite role. See `review-workflow-role-adapters.md` for the resolution and persistence boundary.

When authenticated-subject evidence is absent, CodeMoot reports that independent accounts cannot
be proven. It never stores authentication tokens or un-hashed subject identifiers.

## Commit modes

| Mode | `agentMayCommit` | Permitted implementation commit creator |
| --- | --- | --- |
| `human_required` | `false` | Human |
| `agent_authorized` | `true` | Assigned implementer agent |
| `either` | `true` | Assigned implementer agent or human |

Inconsistent mode and `agentMayCommit` values are rejected during configuration validation.
Creating a commit does not grant implementer or reviewer authority.

## Migration boundaries

- Loading v1 applies v1→v2 and v2→v3 in order.
- Loading v2 applies v2→v3.
- Loading v3 does not rewrite the file.
- A future version fails with a `ConfigError`.
- Unknown fields survive migration.
- Migration adds `kind` to an existing CLI adapter when it can be inferred from the provider.
- Legacy workflow, model aliases, and provider behaviour remain unchanged.
