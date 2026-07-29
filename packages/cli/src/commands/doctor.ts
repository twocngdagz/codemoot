// packages/cli/src/commands/doctor.ts — Preflight diagnostics for CodeMoot

import { constants, accessSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRegistry, VERSION, loadConfig } from '@codemoot/core';
import chalk from 'chalk';

interface Check {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  fix?: string;
}

export async function doctorCommand(): Promise<void> {
  const cwd = process.cwd();
  const checks: Check[] = [];

  console.error(chalk.cyan(`\n  CodeMoot Doctor v${VERSION}\n`));

  // 1. Config file and independently configured adapters.
  const configPath = join(cwd, '.cowork.yml');
  if (existsSync(configPath)) {
    try {
      const config = loadConfig({ projectDir: cwd });
      checks.push({ name: 'config', status: 'pass', message: '.cowork.yml found' });
      const registry = ModelRegistry.fromConfig(config, cwd);
      const adapterHealth = await registry.healthCheckDetails(cwd);
      for (const [alias, health] of adapterHealth) {
        checks.push({
          name: `adapter:${alias}`,
          status: health.available ? 'pass' : 'fail',
          message: health.available
            ? `${health.adapterKind} ${health.version ?? 'version unknown'} (${health.model})`
            : `${health.adapterKind} unavailable: ${health.error ?? health.command}`,
          ...(health.available
            ? {}
            : {
                fix:
                  health.adapterKind === 'claude'
                    ? 'Install or correct the configured Claude CLI command'
                    : 'Install or correct the configured Codex CLI command',
              }),
        });
      }
    } catch (error) {
      checks.push({
        name: 'config',
        status: 'fail',
        message: `.cowork.yml is invalid: ${error instanceof Error ? error.message : String(error)}`,
        fix: 'Correct the configuration and run codemoot doctor again',
      });
    }
  } else {
    checks.push({
      name: 'config',
      status: 'fail',
      message: '.cowork.yml not found',
      fix: 'codemoot init',
    });
  }

  // 2. Database writable
  const dbDir = join(cwd, '.cowork', 'db');
  const dbPath = join(dbDir, 'cowork.db');
  if (existsSync(dbDir)) {
    try {
      accessSync(dbDir, constants.W_OK);
      checks.push({
        name: 'database',
        status: existsSync(dbPath) ? 'pass' : 'warn',
        message: existsSync(dbPath)
          ? 'Database exists and writable'
          : 'Database directory exists, DB will be created on first use',
      });
    } catch {
      checks.push({
        name: 'database',
        status: 'fail',
        message: '.cowork/db/ is not writable',
        fix: 'Check file permissions on .cowork/db/',
      });
    }
  } else {
    checks.push({
      name: 'database',
      status: 'warn',
      message: '.cowork/db/ not found — will be created by codemoot init',
      fix: 'codemoot init',
    });
  }

  // 3. Git repo — traverse up to find .git
  let gitFound = false;
  let searchDir = cwd;
  while (searchDir) {
    if (existsSync(join(searchDir, '.git'))) {
      gitFound = true;
      break;
    }
    const parent = join(searchDir, '..');
    if (parent === searchDir) break;
    searchDir = parent;
  }
  if (gitFound) {
    checks.push({ name: 'git', status: 'pass', message: 'Git repository detected' });
  } else {
    checks.push({
      name: 'git',
      status: 'warn',
      message: 'Not a git repository — diff/shipit/watch features limited',
    });
  }

  // 4. Node version
  const nodeVersion = process.version;
  const major = Number.parseInt(nodeVersion.slice(1).split('.')[0], 10);
  if (major >= 22) {
    checks.push({ name: 'node', status: 'pass', message: `Node.js ${nodeVersion}` });
  } else {
    checks.push({
      name: 'node',
      status: 'fail',
      message: `Node.js ${nodeVersion} — requires 22`,
      fix: 'Install Node.js 22',
    });
  }

  // 5. Schema version check
  if (existsSync(dbPath)) {
    try {
      const { openDatabase } = await import('@codemoot/core');
      const db = openDatabase(dbPath);
      const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
      const version = row?.user_version ?? 0;
      if (version >= 7) {
        checks.push({ name: 'schema', status: 'pass', message: `Schema version ${version}` });
      } else {
        checks.push({
          name: 'schema',
          status: 'warn',
          message: `Schema version ${version} — will auto-migrate on next command`,
        });
      }
      db.close();
    } catch {
      checks.push({ name: 'schema', status: 'warn', message: 'Could not read schema version' });
    }
  }

  // Print results
  let hasFailure = false;
  for (const check of checks) {
    const icon =
      check.status === 'pass'
        ? chalk.green('PASS')
        : check.status === 'warn'
          ? chalk.yellow('WARN')
          : chalk.red('FAIL');
    console.error(`  ${icon} ${check.name}: ${check.message}`);
    if (check.fix) {
      console.error(chalk.dim(`       → ${check.fix}`));
    }
    if (check.status === 'fail') hasFailure = true;
  }

  console.error('');

  // JSON output
  const output = {
    version: VERSION,
    checks,
    healthy: !hasFailure,
  };
  console.log(JSON.stringify(output, null, 2));

  if (hasFailure) {
    process.exit(1);
  }
}
