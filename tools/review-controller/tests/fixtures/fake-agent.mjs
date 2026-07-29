#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

let prompt = await new Promise((resolve) => {
  let value = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    value += chunk;
  });
  process.stdin.on('end', () => resolve(value));
});
const promptFile = option('--prompt-file');
if (promptFile) {
  prompt = await readFile(promptFile, 'utf8');
}

const promptLog = option('--prompt-log');
if (promptLog) {
  await writeFile(promptLog, prompt, 'utf8');
}

const tamperState = option('--tamper-state');
if (tamperState) {
  await writeFile(tamperState, '{"tampered":true}\n', 'utf8');
}

const modifyFile = option('--modify-file');
if (modifyFile) {
  await writeFile(modifyFile, 'unauthorised change\n', 'utf8');
}

const commitFile = option('--commit-file');
if (commitFile) {
  await writeFile(commitFile, 'agent commit\n', 'utf8');
  execFileSync('git', ['add', '--', commitFile], { cwd: process.cwd() });
  execFileSync('git', ['commit', '-m', 'unauthorised agent commit'], {
    cwd: process.cwd(),
  });
}

const counterPath = option('--counter');
let outputPath = option('--output');
const outputs = option('--outputs');
if (outputs && counterPath) {
  let count = 0;
  try {
    count = Number(await readFile(counterPath, 'utf8'));
  } catch {
    count = 0;
  }
  const choices = outputs.split(',');
  outputPath = choices[Math.min(count, choices.length - 1)];
  await writeFile(counterPath, String(count + 1), 'utf8');
}

const exitCode = Number(option('--exit-code') ?? 0);
if (outputPath) {
  process.stdout.write(await readFile(outputPath, 'utf8'));
}
if (exitCode !== 0) {
  process.stderr.write('fake agent failure\n');
}
process.exitCode = exitCode;
