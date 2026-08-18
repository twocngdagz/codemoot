# Relay — the message-bus loop

`codemoot relay` runs a Markdown plan through an implementer⇄reviewer loop in which
**CodeMoot is the wiring and the reviewer is the intelligence**. The plan is a file in the
repo; both models read it off disk themselves; the plan's own `### Batch N` headings are the
decomposition. Nothing transmits, restructures, or re-derives the plan — no refinement
phase, no contracts, no schemas, no criterion IDs, no coverage maps, no reservations, no
token budgets.

```bash
codemoot relay run --plan documentation/plan.md --background
```

`--background` (on `run` and `resume`) detaches the worker with the full parent environment
inherited and stdout/stderr in `.cowork/relay/<run-id>.log`; omit it to watch in the
foreground.

## Every command and argument

The relay is command-line only — there is no MCP tool that starts, resumes, pauses or reads
a relay run. The loop's shape lives entirely in these arguments; `.cowork.yml` supplies the
models, the roles and the wedge-handling defaults (see [Configuration](#configuration)).
Nothing below is required except `--plan`; every default is stated.

### `codemoot relay run`

| Argument | Required | Default | What it does |
| --- | --- | --- | --- |
| `--plan <file>` | **yes** | — | The Markdown plan. Resolved relative to the current directory and stored as an absolute path in the run, so later resumes find it regardless of where you stand. Both models read it off disk themselves; it is never transmitted or rewritten. |
| `--id <run-id>` | no | generated | Pin the run ID instead of taking a generated one. Useful when a script needs to know the ID before the run exists. |
| `--max-cycles <n>` | no | `3` | How many FIX rounds one batch may consume before the loop stops and asks you. Not a deadline — there is no wall-clock or token cap. |
| `--batches <n>` | no | parsed from the plan | Override the batch total. **Read the warning below before using it.** |
| `--start-batch <n>` | no | `1` | Begin at this batch instead of the first. Batches before it are never opened. |
| `--review-from <batch>` | no | off | From this batch on, open at the **reviewer**: the work is already implemented and committed, so review it as it stands. No implementer summary is fabricated. FIX loops, the findings floor and the cycle cap run unchanged. Recorded in the run, so a resume needs no re-flagging. |
| `--background` | no | foreground | Detach the worker; the full parent environment is inherited and output goes to `.cowork/relay/<run-id>.log`. |

**About `--batches`.** The batch total is normally the **highest** `Batch N` number appearing
in any Markdown heading of the plan — not the count of headings — falling back to 1 when the
plan has none. `--batches` replaces that number outright. It does not select, limit or skip
anything: a value above what the plan contains makes the loop open batches the plan never
describes, and a value below it silently ends the run early. Two things it is **not**:

- It is not the workflow's `--max-batches`, which stops a *workflow* after N fully-complete
  batches. Same-looking name, different command, different meaning.
- It is not a way to run one batch. Use `--start-batch` for where to begin, and `relay pause
  <run-id> --after-batch` for where to stop.

### `codemoot relay resume <run-id>`

| Argument | Required | Default | What it does |
| --- | --- | --- | --- |
| `<run-id>` | **yes** | — | The run to continue. |
| `--decision <choice>` | only at a cycle-cap pause | — | `continue` (one more review cycle), `accept` (the implementer applies the last feedback as final, then the batch advances), or `proceed` (advance as-is). Rejected as invalid at any other kind of pause. |
| `--background` | no | foreground | As on `run`. |

### `codemoot relay pause <run-id>`

| Argument | Required | Default | What it does |
| --- | --- | --- | --- |
| `<run-id>` | **yes** | — | The run to stop. |
| `--after-batch` | no | stop at the next call boundary | Stop exactly when the current batch is accepted instead. Intent only — the loop honours it at a boundary no external poll can reliably hit. |

### `codemoot relay status <run-id>` / `codemoot relay log <run-id>`

| Argument | Required | Default | What it does |
| --- | --- | --- | --- |
| `<run-id>` | **yes** | — | The run to read. |
| `--full` (`log` only) | no | truncated | Print complete prompts and responses instead of excerpts. |

### There is no `--plan-as-is` here, and none is needed

`--plan-as-is` belongs to `codemoot workflow run`, where a refinement phase would otherwise
rewrite your plan into generated batch plans and put them through a plan-review gate; the
flag turns that off. **The relay has no such phase to turn off.** Your plan is used exactly
as written, always: the relay never transmits, restructures, summarises or re-authors it, and
its own `Batch N` headings are the decomposition. Passing `--plan-as-is` to `relay run` is an
error — the flag does not exist on this command.

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
asks you rather than guessing. The token is read the way a human reads it: a reviewer that
runs its next sentence straight onto the verdict (`VERDICT: FIXBoth reviews are complete…`)
still routes, while a genuinely different word (`fixme`, `Proceeding`) or prose between the
colon and the token (`VERDICT: CANNOT PROCEED`) does not — those pause.

One shape rule guards the one irreversible act: **`PROCEED` and `COMPLETE` must arrive
attached to findings.** A reply that is a verdict line and (almost) nothing else is treated
like a missing verdict — the relay pauses, and resume re-sends the full review prompt. The
relay still never grades review quality; it refuses to advance a batch on a routing token
with no review behind it (a live run once advanced an unreviewed batch on 72 characters).
`FIX` is exempt: it advances nothing and a terse FIX errs in the safe direction. An accepted
review far shorter than that reviewer's own norm also gets a warning line in the log.

Resuming an unclear-verdict pause first re-reads the **stored** reply: if it parses to a
routable verdict now (say, after the parser learned a new reviewer's habits), it is routed
as it stands with no model call — the review already happened. Only a reply with genuinely
nothing routable gets the full review prompt re-sent. Nothing ever asks a reviewer to
"restate your conclusion" without context: a session with no memory of the batch once
answered exactly that by inventing a verdict.

## Reviewing work that already exists

The loop above assumes every batch is unbuilt. Pointed at a batch that was implemented and
committed **outside the run** — by hand, or by a previous run — the opening "implement it
fully" would re-implement code that already exists on the branch. `--review-from <batch>`
makes every batch from that number on open at the **reviewer** instead:

```bash
codemoot relay run --plan documentation/plan.md --start-batch 9 --review-from 9
```

The reviewer is told the batch was implemented outside the run — no implementer summary is
fabricated — and reviews the repository's current state against the plan's own Batch N
section. Only the opening move differs: a `FIX` forwards the findings to the implementer
and the fix→re-review loop runs exactly as always; `PROCEED`/`COMPLETE` advance as always;
the findings floor and the cycle cap apply unchanged. The range is recorded in the run, so
a resume needs no re-flagging. It composes with `--start-batch`: the example starts at
batch 9 and reviews 9 and 10 without ever touching 1–8.

## When the CLI wedges

`cursor-agent` freezes mid-call: the process stays alive, its HTTP stream is dead, and it
emits nothing ever again. That is an upstream bug, publicly documented, so the relay treats
it as weather rather than an accident. One live run paid the full price for it — fourteen
hours, ten consecutive interrupted attempts on one step, an eight-hour overnight hang, and
several worker deaths that left no trace at all. Four things changed.

### Silence is examined, not merely waited out

The idle deadline used to be the whole verdict, and silence means two opposite things: an
agent running a long local test suite is quiet for minutes, and a wedged CLI is quiet
forever. Raising `idleTimeout` to protect the first turned the second into multi-hour hangs;
lowering it killed real work.

So at the deadline the operating system is asked which one this is: **has the child's
process tree actually burned CPU since the last look?** A working agent — or any tool it
spawned — burns measurable CPU; a wedged process waiting on a dead socket burns none (the
live one sat on ~8 seconds over eight hours). If it is working, the call gets another
interval and the transcript records that its silence was examined. If it is not, the kill
that `idleTimeout` ordered proceeds.

The probe fails closed in every ambiguous case — probe disabled, no child pid, an unreadable
process tree, extensions exhausted — because a probe that cannot see the process must never
be the reason a wedged call survives. `cliAdapter.timeout` remains the absolute ceiling and
is never extended.

```yaml
models:
  implementer:
    cliAdapter:
      idleTimeout: 900      # stream silence tolerated before the child is EXAMINED
      liveness:
        enabled: true       # false ⇒ the deadline is the verdict, as before
        minCpuRatio: 0.01   # fraction of one core that counts as working
        probeInterval: 60   # seconds per granted extension (also the measurement window)
        maxExtensions: 30   # ceiling per call; `timeout` still applies
```

### A stalled conversation is not resumed forever

An interrupted call is re-sent with the reconcile preface — into the **same** CLI session, so
each retry stacked another apology onto an ever-longer conversation. After several of those
the live session stopped answering at all; clearing the stored session id ended the hang, and
the fresh conversation finished the same step in eighteen minutes.

After `relay.freshSessionAfterInterrupts` interrupted attempts on one step (default **1**),
the next attempt starts a **fresh** session and the transcript says so. Nothing is lost: the
reconcile preface already tells the model to inspect the working tree, and committed work is
on the branch either way. Set it to `0` to always resume, as before.

### A failed call is retried, and every death is on the record

A call failure used to end the worker. Recovery then depended on a human noticing silence —
and several worker deaths wrote nothing at all: no event, no log line, a run sitting at
STOPPED with no reason in it.

Now the worker retries the step in place with bounded backoff, up to `advanced.retryAttempts`
(default 3), recording every attempt; when the attempts run out it stops exactly as it did
before. Every other way the worker can end — SIGINT, SIGTERM, an uncaught exception, an
unhandled rejection, or simply exiting while the run still says ACTIVE — writes its reason
first. `relay status` reports the newest one as `lastFailure`, so a stalled run explains
itself:

```json
{ "status": "STOPPED", "lastFailure": { "reason": "Cursor CLI idle timeout …", "at": "…" } }
```

Only SIGKILL can still leave nothing behind; a run left ACTIVE with a dead lease is the
signature of one. `--background` is a launcher, not a worker: it hands the run to the child
and takes none of this with it, so an exiting launcher never files a death for a run its own
child is working.

An interrupted call is re-sent with the reconcile note added **once**, however many times the
step has been interrupted — a prompt that is one-third apology teaches the model the wrong
thing about the task.

### The raw stream is kept, so a freeze can be read

The adapter's stream-json output fed the idle timer and was then discarded, so diagnosing the
freezes needed process and socket forensics on a machine that had already moved on. Every
call now tees its raw stdout and stderr to

```
.cowork/relay/<run-id>/calls/<seq>-<role>.jsonl
```

and failure notes name the file. A wedge is diagnosed by reading its last line: a tool call
means the child died waiting on a command; mid-sentence text means the stream itself died.
Capped per call and pruned per run (`relay.callStream.maxBytesPerCall`, `keepCalls`) — a
diagnostic that fills a disk is a defect. `relay.callStream.enabled: false` turns it off.

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

```bash
codemoot relay pause <run-id>                # graceful: current call finishes, then stop
codemoot relay pause <run-id> --after-batch  # stop exactly when the current batch is accepted
```

`pause` signals the pid recorded in the run's own lease — never a pattern match (a watcher
once pgrep'd the run id, matched its own command line, and signalled itself). The intent is
also written durably, so a lost signal still stops the loop at its next call boundary, and
`--after-batch` is intent only: the loop honours it exactly at the batch's acceptance, a
boundary no external poll can reliably hit. Ctrl-C on a foreground worker does the same
graceful stop. Every RESPONSE in the transcript records **which model** produced it, so
mid-run model or vendor swaps stay visible in the audit. Resume needs no ceremony —

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

Everything the relay itself takes is optional, and every default is the behaviour that
survives a wedged CLI:

```yaml
relay:
  freshSessionAfterInterrupts: 1   # 0 ⇒ always resume the stored session
  callStream:
    enabled: true
    maxBytesPerCall: 20971520      # 20MB
    keepCalls: 200                 # per-run file retention
advanced:
  retryAttempts: 3                 # in-place retries per failed call; 1 ⇒ stop on first failure
```
