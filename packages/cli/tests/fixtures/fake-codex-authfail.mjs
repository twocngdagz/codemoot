#!/usr/bin/env node
// A Codex CLI stand-in that always fails like a logged-out CLI: integration tests use it to
// prove failed reviewer invocations are audited and classified as AUTHENTICATION failures.
process.stderr.write('ERROR: not logged in. Run `codex login` to authenticate.\n');
process.exit(1);
