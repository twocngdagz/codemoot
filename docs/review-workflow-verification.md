# Verification Evidence and Acceptance

The review-gated workflow deliberately separates a command or observation from the decision to
accept it.

## Verification records

`ReviewWorkflowVerificationService.execute()` runs an approved executable with an exact argument
array. It never invokes a shell. Before execution, it reads repository `HEAD` and requires it to
match the expected commit. After execution, it reads `HEAD` again. A concurrent head change does
not erase the factual result; the returned record remains bound to the starting commit and reports
that the head changed, so it cannot later be accepted as current evidence.

`ReviewWorkflowVerificationService.ingest()` captures evidence produced outside the local runner.
Callers must classify it as:

- `TRUSTED_CI`, which requires a durable CI executor identity; or
- `EXTERNAL`, which always requires reviewer or human judgment before acceptance.

Both paths persist the same immutable `VerificationRecord`. The record contains the executable,
arguments, working directory, timing, outcome, related criteria/findings, commit SHA, executor
identity, tool version, verification-configuration hash, a bounded output summary, and the
location and SHA-256 hash of the full log.

`LocalVerificationLogStore` writes logs with owner-only permissions under a caller-selected
directory. Filenames are hashes of record IDs, so record IDs cannot escape that directory. A
second write is accepted only when its content is byte-for-byte identical.

## Attestations

An exit code of zero is not an approval. `attest()` loads the persisted record and durable attestor
identity, checks `VERIFICATION_ATTESTOR` authority, binds the decision to the record hash, and
persists a separate immutable `VerificationAttestation`.

Automatic system acceptance requires all of the following:

- the record came from the CodeMoot runner or trusted CI;
- the exact executable, arguments, working directory, verification type, and criterion IDs match
  the approved command;
- the command succeeded;
- tool version and verification-configuration hash match policy;
- the evidence and policy are bound to the current expected commit;
- every related criterion explicitly permits automatic acceptance;
- the record has no related findings or parser ambiguity; and
- the evidence is not manual, browser, static-analysis, baseline-comparison, externally supplied,
  or produced by the assigned implementer.

Evidence requiring judgment can be accepted only by the assigned reviewer or an independent human.
This includes manual/browser evidence, external evidence, implementer-only claims, nonzero/error
outcomes, static-analysis results, evidence related to findings, parser ambiguity, and criteria
configured for independent attestation. Baseline-comparison evidence is reserved for the later
baseline batch and requires assigned-reviewer acceptance.

The persistence layer independently checks that an attestation's record hash, workflow/batch,
criteria, findings, verification type, and executor identity match its referenced record.

## Integration boundary

This module is an internal interface for later `verify` and `attest-verification` commands. It does
not register CLI or MCP commands, evaluate the final merge gate, normalize tool baselines, run
background jobs, or accept/perform a merge.
