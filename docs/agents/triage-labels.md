# Triage Labels

Each triaged issue must carry exactly one workflow-state label.

| Canonical role | Repository label | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer evaluation is required |
| `needs-info` | `needs-info` | Additional information is required |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an implementation agent |
| `ready-for-human` | `ready-for-human` | Human judgment or implementation is required |
| `wontfix` | `wontfix` | The issue will not be actioned |

Use exactly one broad category:

- `bug` for incorrect externally observable behaviour.
- `enhancement` for improvements that are not existing behavioural defects.

The optional `tech-debt` label identifies internal quality debt or carried-forward
review findings. Apply it in addition to `enhancement`; it does not replace the
workflow-state or broad-category label.

Do not apply `needs-triage` to findings that are already fully specified and classified.
