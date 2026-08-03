# Relay — the message-bus loop

`codemoot relay` runs a Markdown plan through an implementer⇄reviewer loop in which
**CodeMoot is the wiring and the reviewer is the intelligence**. The plan is a file in the
repo; both models read it off disk themselves; the plan's own `### Batch N` headings are the
decomposition. Nothing transmits, restructures, or re-derives the plan — no refinement
phase, no contracts, no schemas, no criterion IDs, no coverage maps, no reservations, no
token budgets.

```bash
codemoot relay run --plan documentation/plan.md
```

## The loop

1. The implementer is told: *do Batch N per the plan*. It works, commits locally, stops on
   its own, and replies with a summary — what it did, what it changed, what it ran, the
   resulting commits.
2. The relay forwards that summary to the reviewer, verbatim.
3. The reviewer reads Batch N in the plan itself, checks the diff against the claims, runs
   whatever verification it judges necessary, and replies with findings ending in one line:
   `VERDICT: FIX`, `VERDICT: PROCEED`, or `VERDICT: COMPLETE`.
4. `FIX` → the relay forwards the review to the implementer, verbatim. `PROCEED` → next
   batch. `COMPLETE` → done.

The relay does exactly four things: **carry messages, health-check the running model, count
feedback cycles, and record everything.** It holds no model of the work and judges nothing.
The `VERDICT:` line is the single piece of structure in the whole system — the bus has to
know which wire to put a reply on — and when it is missing or ambiguous the relay pauses and
asks you rather than guessing.

One shape rule guards the one irreversible act: **`PROCEED` and `COMPLETE` must arrive
attached to findings.** A reply that is a verdict line and (almost) nothing else is treated
like a missing verdict — the relay pauses, and resume re-sends the full review prompt. The
relay still never grades review quality; it refuses to advance a batch on a routing token
with no review behind it (a live run once advanced an unreviewed batch on 72 characters).
`FIX` is exempt: it advances nothing and a terse FIX errs in the safe direction. An accepted
review far shorter than that reviewer's own norm also gets a warning line in the log.

## Liveness, not deadlines

A model that is producing output is left alone however long it takes. Health is the
adapter's `idleTimeout` (silence), and `--include-partial-messages` in the model's
`cliAdapter.args` keeps output flowing during long generations. There is no wall-clock
limit and no token budget: the only cap is `--max-cycles` (default 3) — how many FIX rounds
one batch may consume before the **operator** decides:

```bash
codemoot relay resume <run-id> --decision continue   # one more review cycle
codemoot relay resume <run-id> --decision accept     # implementer applies the last feedback as final, then advances
codemoot relay resume <run-id> --decision proceed    # advance as-is
```

## Pause and resume

Stopping is graceful: Ctrl-C finishes the current call, records it, and exits. Resume needs
no ceremony —

```bash
codemoot relay resume <run-id>
```

— because the event log *is* the state. The relay looks at the last recorded exchange and
does the one thing it implies. One worker per run is enforced, not assumed: each run records
the pid that holds it, and a second `run`/`resume` is refused while that process is alive —
the refusal names the pid so a genuinely stuck holder can be killed and resumed past. If the log ends with a prompt that has no reply (a crash
mid-call), the same prompt is re-sent with one sentence telling the model its previous
attempt may have been interrupted and the working tree may hold partial work — the
intelligence reconciles it, not a recovery state machine.

## The transcript

Every prompt and every response is recorded, with tokens and duration:

```bash
codemoot relay status <run-id>
codemoot relay log <run-id> --full
```

The transcript exists for **human audit** — you, or another model you hand it to — never
for machine enforcement.

## What still holds

The git guard and credential-less environment apply to every call: agents can read and
commit locally, and cannot push, rewrite history, or reach credentials. The implementer and
reviewer must be **different model aliases** with their own sessions — reviewer independence
is the product, not a guard.

## Configuration

Only `models` and `roles` are required — `reviewGated` is not used:

```yaml
models:
  implementer:
    provider: anthropic
    model: claude-opus-5
    cliAdapter:
      kind: claude
      command: claude
      args: [--effort, max, --include-partial-messages]
      timeout: 604800        # ceiling only; liveness is idleTimeout, not elapsed time
      idleTimeout: 900
  reviewer:
    provider: anthropic
    model: claude-fable-5
    cliAdapter:
      kind: claude
      command: claude
      args: [--effort, max, --include-partial-messages]
      timeout: 604800
      idleTimeout: 900
roles:
  implementer: { model: implementer }
  reviewer: { model: reviewer }
```
