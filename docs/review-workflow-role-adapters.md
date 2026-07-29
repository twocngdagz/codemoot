# Review-Workflow Role Adapters

`models` defines configured agents and `roles` assigns those agents to work. The registry selects
the concrete bridge from each model's `cliAdapter.kind`; role callers do not infer an adapter from
an alias name.

Both directions are supported:

```yaml
roles:
  implementer:
    model: claude-agent
  reviewer:
    model: codex-agent
```

Swapping the two model values swaps the runtime bridges. Review-gated configuration still
requires distinct configured agent keys and, when enabled by policy, distinct adapter kinds.
Legacy Codex-only configuration continues to infer `codex` and uses the existing `CliAdapter`
compatibility class.

## Runtime resolution

Workflow start creates immutable `AgentAssignment` snapshots. Before an invocation,
`RoleManager.resolveReviewWorkflowRoles` checks each snapshot against:

- the configured role and model alias
- the configured and runtime model
- the expected and runtime adapter kind
- the implementer or reviewer authority

The invocation service accepts that resolution rather than a caller-selected alias. Successful
bridge calls must return process-attested invocation evidence and vendor-session evidence.
CodeMoot then stores the assignment, invocation identity, session identity, and actor execution
links together.

## Session isolation

A stored session is scoped to one workflow, one assigned role, and one adapter. Resume is refused
before invocation when any of those values differs. Returned evidence is also checked so a bridge
cannot silently report a vendor session already used by the opposite role.

Legacy commands still expose fields such as `codexThreadId` for output and database compatibility.
Those fields now carry the selected bridge's vendor session ID; their names do not select Codex.

## Assurance boundary

Both built-in bridges report executable path and hash, CLI version, configured model, working
directory, process ID and fingerprint, timestamps, and session identity. This supports
`PROCESS_ATTESTED` assurance.

Neither bridge currently exposes a stable authenticated account subject through its supported
machine-readable protocol. CodeMoot therefore does not claim account-level independence and does
not persist raw credentials or account identifiers.

`codemoot doctor` probes every configured model alias independently and reports the adapter kind,
model, executable availability, and CLI version. The probe does not run a model request or perform
an authentication smoke test.
