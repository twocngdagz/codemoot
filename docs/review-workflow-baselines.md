# Verification Baselines

Review-workflow baselines make an existing backlog explicit without treating a total finding
count as a quality gate. They preserve the factual output of an approved verification command,
normalize each finding into a stable fingerprint, and require an assigned reviewer to accept the
capture before it can be used.

## Creation and approval

A baseline must originate from an immutable `VerificationRecord`. The record binds the exact
command and arguments, working directory, tool version, configuration hash, commit SHA, exit
code, and content-addressed raw log. Baseline capture re-reads that log, verifies its hash and
its agreement with the record, then writes a separate immutable normalized-finding artifact.

The capture also records:

- every repository-relative configuration input path;
- the normalizer identity and schema version;
- the complete normalized finding set and count;
- the artifact and raw-log locations and hashes; and
- the capture actor and timestamp.

The assigned reviewer must inspect the raw and normalized evidence and create an explicit
`ACCEPTED` approval. A newly captured immutable baseline records its approval state as `PENDING`;
the separate append-only approval record preserves the later decision without mutating history.
The capture actor cannot approve its own baseline. Rejected baselines remain in the audit history
and cannot be used for comparison.

For Biome, capture the JSON reporter output without a diagnostic limit. A report that says
diagnostics were omitted is rejected rather than treated as a complete backlog.

## Finding identity

A fingerprint is derived from the rule identifier, repository-relative file, normalized
message, category, severity, optional symbol or structural context, and a deterministic
occurrence index for duplicates. Line and column locations are retained as evidence, but are not
the sole identity because unrelated edits can move an unchanged finding.

Comparison is a multiset operation:

- `introduced = current − baseline`
- `resolved = baseline − current`
- `unchanged = current ∩ baseline`

Any introduced finding fails the comparison. A result with the same total count can therefore
fail when one old finding was resolved and a different finding was introduced.

## Comparability and acceptance

The current record must use the same command, tool name and version, configuration input set and
hash, normalizer, and normalization schema version. Drift in any of these fields produces an
immutable `INCOMPARABLE` result; it is never interpreted as a pass.

Comparison and acceptance remain separate facts. The assigned reviewer may accept only a
`PASSED` comparison at the current repository HEAD and must attest that:

- the approved baseline remains trustworthy;
- tool version and configuration are comparable;
- the introduced set is empty; and
- the affected rules and files were normalized correctly.

Baseline records, approvals, comparisons, comparison attestations, and normalized artifacts are
append-only. Rollback means stopping their use in later policy evaluation, never deleting audit
history.

This mechanism does not authorize lint cleanup. Existing Biome findings remain separate debt;
new findings are blocked without reformatting or fixing unrelated files.
