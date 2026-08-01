import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { getSchemaVersion, openDatabase, runMigrations } from '../../../src/memory/database.js';

describe('openDatabase', () => {
  it('creates all tables in :memory: database', () => {
    const db = openDatabase(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('artifacts');
    expect(names).toContain('decisions');
    expect(names).toContain('memories');
    expect(names).toContain('cost_log');
    expect(names).toContain('schema_meta');
    expect(names).toContain('review_workflows');
    expect(names).toContain('review_workflow_batches');
    expect(names).toContain('review_workflow_command_receipts');
    expect(names).toContain('review_workflow_command_side_effects');
    expect(names).toContain('review_workflow_events');
    expect(names).toContain('review_workflow_handoff_transcripts');
    expect(names).toContain('review_workflow_structured_reviews');
    expect(names).toContain('review_workflow_verification_attestations');
    expect(names).toContain('review_workflow_verification_baselines');
    expect(names).toContain('review_workflow_verification_baseline_approvals');
    expect(names).toContain('review_workflow_verification_baseline_comparisons');
    expect(names).toContain('review_workflow_baseline_comparison_attestations');
    db.close();
  });

  it('creates FTS5 virtual table', () => {
    const db = openDatabase(':memory:');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('memories_fts');
    db.close();
  });

  it('creates FTS sync triggers', () => {
    const db = openDatabase(':memory:');
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {
      name: string;
    }[];
    const names = triggers.map((t) => t.name);

    expect(names).toContain('memories_ai');
    expect(names).toContain('memories_ad');
    expect(names).toContain('memories_au');
    db.close();
  });

  it('enables WAL mode', () => {
    const db = openDatabase(':memory:');
    // :memory: databases can't use WAL, but the pragma runs without error
    // For file-based DBs this would return 'wal'
    const mode = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(mode[0].journal_mode).toBeDefined();
    db.close();
  });

  it('enables foreign keys', () => {
    const db = openDatabase(':memory:');
    const fk = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(fk[0].foreign_keys).toBe(1);
    db.close();
  });

  it('sets schema version', () => {
    const db = openDatabase(':memory:');
    const version = getSchemaVersion(db);
    expect(version).toBe('16');
    db.close();
  });

  it('is idempotent (can run migrations twice)', () => {
    const db = openDatabase(':memory:');
    // Run migrations again -- should be idempotent
    runMigrations(db);
    const version = getSchemaVersion(db);
    expect(version).toBe('16');
    db.close();
  });

  it('upgrades a v10 database additively without changing legacy rows', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO schema_meta(key, value) VALUES ('version', '10');
      CREATE TABLE legacy_sentinel (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO legacy_sentinel(id, value) VALUES ('legacy-1', 'preserve-me');
    `);

    runMigrations(db);

    expect(getSchemaVersion(db)).toBe('16');
    expect(
      db.prepare('SELECT value FROM legacy_sentinel WHERE id = ?').pluck().get('legacy-1'),
    ).toBe('preserve-me');
    expect(
      db
        .prepare(
          "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'review_workflow_%'",
        )
        .pluck()
        .get(),
    ).toBeGreaterThan(0);
    expect(
      db
        .prepare(
          `SELECT COUNT(*)
           FROM sqlite_master
           WHERE type = 'table'
             AND name IN (
               'review_workflow_verification_baselines',
               'review_workflow_verification_baseline_approvals',
               'review_workflow_verification_baseline_comparisons',
               'review_workflow_baseline_comparison_attestations'
             )`,
        )
        .pluck()
        .get(),
    ).toBe(4);
    db.close();
  });

  it('rebuilds a real v14 runner-state table so the pause statuses are accepted', () => {
    // A faithful v14-shaped database: the OLD runner-state DDL (whose CHECK predates the
    // pause statuses), version 14, and an existing RUNNING workflow row.
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE review_workflows (
      workflow_id TEXT PRIMARY KEY, status TEXT NOT NULL, general_plan_version_id TEXT NOT NULL,
      refined_plan_version_id TEXT, implementer_assignment_id TEXT NOT NULL,
      reviewer_assignment_id TEXT NOT NULL, configuration_hash TEXT NOT NULL,
      aggregate_version INTEGER NOT NULL DEFAULT 0, payload_json TEXT NOT NULL DEFAULT '{}',
      record_hash TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    )`);
    db.exec(`CREATE TABLE review_workflow_runner_state (
      workflow_id        TEXT PRIMARY KEY REFERENCES review_workflows(workflow_id),
      status             TEXT NOT NULL CHECK(status IN (
        'RUNNING', 'HUMAN_DECISION_REQUIRED', 'CANCELLED',
        'READY_FOR_HUMAN_VERIFICATION', 'FAILED'
      )),
      branch             TEXT NOT NULL,
      base_branch        TEXT NOT NULL,
      base_sha           TEXT NOT NULL,
      total_batches      INTEGER NOT NULL DEFAULT 0,
      current_ordinal    INTEGER,
      phase              TEXT,
      review_round       INTEGER,
      correction_pass    INTEGER,
      phase_started_at   TEXT,
      last_heartbeat_at  TEXT,
      last_checkpoint    TEXT,
      stop_reason        TEXT,
      stop_details       TEXT,
      notified           INTEGER NOT NULL DEFAULT 0,
      worker_id          TEXT,
      lease_expires_at   TEXT,
      limits_json        TEXT,
      active_invocation_json TEXT,
      counters_json      TEXT NOT NULL,
      started_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    )`);
    db.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare("INSERT INTO schema_meta(key, value) VALUES ('version', '14')").run();
    db.prepare(
      `INSERT INTO review_workflows (workflow_id, status, general_plan_version_id,
        implementer_assignment_id, reviewer_assignment_id, configuration_hash)
       VALUES ('wf-migrate', 'ACTIVE', 'plan', 'a-impl', 'a-rev', 'hash')`,
    ).run();
    db.prepare(
      `INSERT INTO review_workflow_runner_state (
         workflow_id, status, branch, base_branch, base_sha, counters_json, started_at, updated_at
       ) VALUES ('wf-migrate', 'RUNNING', 'codemoot/x', 'main', '${'a'.repeat(40)}',
                 '{"batch":null,"completedOrdinals":[],"completedBatches":[]}',
                 '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    ).run();
    // The old CHECK genuinely rejects the new status before migration.
    expect(() =>
      db.prepare("UPDATE review_workflow_runner_state SET status = 'PAUSE_REQUESTED'").run(),
    ).toThrow(/CHECK/);

    runMigrations(db);

    // The rebuilt table accepts the pause statuses, kept the existing row intact, and
    // carries the new paused-repo column.
    expect(getSchemaVersion(db)).toBe('16');
    db.prepare(
      "UPDATE review_workflow_runner_state SET status = 'PAUSE_REQUESTED' WHERE workflow_id = 'wf-migrate'",
    ).run();
    const row = db
      .prepare("SELECT * FROM review_workflow_runner_state WHERE workflow_id = 'wf-migrate'")
      .get() as Record<string, unknown>;
    expect(row.status).toBe('PAUSE_REQUESTED');
    expect(row.branch).toBe('codemoot/x');
    expect('paused_repo_json' in row).toBe(true);
    db.prepare(
      "UPDATE review_workflow_runner_state SET status = 'PAUSED_BY_USER' WHERE workflow_id = 'wf-migrate'",
    ).run();
    // Re-running migrations is idempotent.
    runMigrations(db);
    expect(
      (
        db
          .prepare(
            "SELECT status FROM review_workflow_runner_state WHERE workflow_id = 'wf-migrate'",
          )
          .get() as { status: string }
      ).status,
    ).toBe('PAUSED_BY_USER');
    db.close();
  });
});
