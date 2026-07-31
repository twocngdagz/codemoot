// Shared helpers for the scenario-driven fake agent CLIs used by
// workflow-run-lifecycle.test.ts. The scenario lives at <cwd>/.cowork/scenario (both
// adapters spawn their fake with the project directory as cwd, and `.cowork/` is
// gitignored so scenario bookkeeping never dirties the audited worktree). Each fake
// consumes numbered step files (`<role>-1.json`, `<role>-2.json`, ...) through a durable
// per-role call counter, so the exact invocation ORDER of the real workflow is asserted
// by construction: a step consumed out of order produces a contract the coordinators
// reject, and a missing step fails the invocation like a crashed CLI.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Reads the complete prompt piped through stdin, exactly like the real CLIs. */
export async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return text;
}

/**
 * Consumes the next scripted step for one role. A missing step file behaves like a
 * crashed/exhausted CLI: a diagnostic on stderr and a non-zero exit.
 */
export function takeStep(role) {
  const directory = join(process.cwd(), '.cowork', 'scenario');
  const counterFile = join(directory, `${role}-calls`);
  const previous = existsSync(counterFile)
    ? Number.parseInt(readFileSync(counterFile, 'utf8').trim(), 10)
    : 0;
  const index = previous + 1;
  writeFileSync(counterFile, String(index));
  const stepFile = join(directory, `${role}-${index}.json`);
  if (!existsSync(stepFile)) {
    process.stderr.write(`scenario exhausted: missing step file ${stepFile}\n`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(stepFile, 'utf8'));
}

/**
 * Runs the step's optional shell command (through /bin/sh, under the guarded PATH the
 * adapter injected) and renders the step response with prompt-derived substitutions:
 *
 * - `"{{TARGET}}"` — replaced by the authoritative review target JSON echoed in the
 *   prompt after the "Echo this authoritative ... target" instruction.
 * - `{{HEAD}}` — replaced by the current `git rev-parse HEAD` (after the shell ran, so
 *   an implementation step substitutes the commit it just created).
 * - `{{FINDING_ID}}` — replaced by the first derived finding identifier named in the
 *   prompt (`finding-<sha256>`), for disposition results.
 */
export function renderResponse(step, prompt) {
  if (typeof step.shell === 'string' && step.shell.length > 0) {
    execFileSync('/bin/sh', ['-c', step.shell], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  let text = typeof step.response === 'string' ? step.response : JSON.stringify(step.response);
  if (text.includes('"{{TARGET}}"')) {
    text = text.replace('"{{TARGET}}"', extractAuthoritativeTarget(prompt));
  }
  if (text.includes('{{HEAD}}')) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
    text = text.split('{{HEAD}}').join(head);
  }
  if (text.includes('{{FINDING_ID}}')) {
    const match = prompt.match(/finding-[0-9a-f]{64}/);
    if (match === null) {
      process.stderr.write('scenario step needs {{FINDING_ID}} but the prompt names none\n');
      process.exit(1);
    }
    text = text.split('{{FINDING_ID}}').join(match[0]);
  }
  return text;
}

/** Extracts the flat JSON target object the prompt asks the reviewer to echo verbatim. */
function extractAuthoritativeTarget(prompt) {
  const marker = prompt.indexOf('Echo this authoritative');
  if (marker === -1) {
    process.stderr.write('scenario step needs {{TARGET}} but the prompt has no target\n');
    process.exit(1);
  }
  const start = prompt.indexOf('{', marker);
  let depth = 0;
  for (let index = start; index < prompt.length; index += 1) {
    if (prompt[index] === '{') depth += 1;
    if (prompt[index] === '}') {
      depth -= 1;
      if (depth === 0) return prompt.slice(start, index + 1);
    }
  }
  process.stderr.write('scenario step could not brace-match the prompt target\n');
  process.exit(1);
  return '';
}
