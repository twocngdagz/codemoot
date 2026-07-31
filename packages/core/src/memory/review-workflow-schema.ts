// Additive SQLite schema for review-gated workflow persistence.

export const REVIEW_WORKFLOW_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS review_workflows (
    workflow_id                TEXT PRIMARY KEY,
    status                     TEXT NOT NULL CHECK(status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
    general_plan_version_id    TEXT NOT NULL,
    refined_plan_version_id    TEXT,
    implementer_assignment_id  TEXT NOT NULL,
    reviewer_assignment_id     TEXT NOT NULL,
    configuration_hash         TEXT NOT NULL,
    aggregate_version          INTEGER NOT NULL DEFAULT 0 CHECK(aggregate_version >= 0),
    payload_json               TEXT NOT NULL,
    record_hash                TEXT NOT NULL,
    created_at                 TEXT NOT NULL,
    updated_at                 TEXT NOT NULL,
    CHECK(implementer_assignment_id <> reviewer_assignment_id)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_review_workflows_status ON review_workflows(status)',

  `CREATE TABLE IF NOT EXISTS review_workflow_batches (
    batch_id                    TEXT PRIMARY KEY,
    workflow_id                 TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    ordinal                     INTEGER NOT NULL CHECK(ordinal > 0),
    persisted_state             TEXT NOT NULL CHECK(persisted_state IN (
      'DRAFT',
      'PLAN_REVIEW',
      'PLAN_NEEDS_REVISION',
      'APPROVED_FOR_IMPLEMENTATION',
      'IMPLEMENTING',
      'AWAITING_COMMIT',
      'IMPLEMENTATION_COMPLETE',
      'CODE_REVIEW',
      'NEEDS_REVISION',
      'VERIFYING',
      'APPROVED_FOR_MERGE',
      'APPROVAL_STALE',
      'MERGED',
      'BLOCKED',
      'CANCELLED'
    )),
    aggregate_version           INTEGER NOT NULL CHECK(aggregate_version >= 0),
    last_event_sequence         INTEGER NOT NULL DEFAULT 0 CHECK(last_event_sequence >= 0),
    current_plan_version_id     TEXT NOT NULL,
    implementer_assignment_id   TEXT NOT NULL,
    reviewer_assignment_id      TEXT NOT NULL,
    original_batch_base_sha     TEXT,
    blocked_from_state          TEXT,
    blocked_resume_state        TEXT,
    payload_json                TEXT NOT NULL,
    record_hash                 TEXT NOT NULL,
    created_at                  TEXT NOT NULL,
    updated_at                  TEXT NOT NULL,
    UNIQUE(workflow_id, ordinal),
    CHECK(implementer_assignment_id <> reviewer_assignment_id),
    CHECK(
      (persisted_state = 'BLOCKED' AND blocked_from_state IS NOT NULL AND blocked_resume_state IS NOT NULL)
      OR
      (persisted_state <> 'BLOCKED' AND blocked_from_state IS NULL AND blocked_resume_state IS NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_batches_state
    ON review_workflow_batches(workflow_id, persisted_state)`,

  // batch_id deliberately has no foreign key here: CREATE_BATCH must be reserved
  // durably before the batch aggregate exists.
  `CREATE TABLE IF NOT EXISTS review_workflow_command_receipts (
    command_id                    TEXT PRIMARY KEY,
    workflow_id                   TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    batch_id                      TEXT NOT NULL,
    command_type                  TEXT NOT NULL,
    expected_aggregate_version    INTEGER NOT NULL CHECK(expected_aggregate_version >= 0),
    canonical_request_hash        TEXT NOT NULL,
    target_commit_sha             TEXT,
    requester_actor_execution_id  TEXT NOT NULL,
    authority_exercised           TEXT NOT NULL,
    status                        TEXT NOT NULL CHECK(status IN (
      'RESERVED',
      'RUNNING',
      'SUCCEEDED',
      'FAILED_FINAL',
      'TIMED_OUT',
      'OUTCOME_UNKNOWN',
      'RECONCILED'
    )),
    side_effect_identity          TEXT,
    resulting_aggregate_version   INTEGER CHECK(resulting_aggregate_version >= 0),
    resulting_event_sequence      INTEGER CHECK(resulting_event_sequence >= 0),
    result_hash                   TEXT,
    result_json                   TEXT,
    error_code                    TEXT,
    request_json                  TEXT NOT NULL,
    created_at                    TEXT NOT NULL,
    updated_at                    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_receipts_batch
    ON review_workflow_command_receipts(workflow_id, batch_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_receipts_status
    ON review_workflow_command_receipts(status, updated_at)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_command_side_effects (
    command_id             TEXT PRIMARY KEY
                           REFERENCES review_workflow_command_receipts(command_id),
    side_effect_kind       TEXT NOT NULL CHECK(side_effect_kind IN (
      'AGENT_INVOCATION',
      'VERIFICATION_EXECUTION'
    )),
    state                  TEXT NOT NULL CHECK(state IN (
      'NOT_STARTED',
      'STARTING',
      'OUTCOME_RECORDED'
    )),
    side_effect_identity   TEXT,
    created_at             TEXT NOT NULL,
    started_at             TEXT,
    outcome_recorded_at    TEXT,
    updated_at             TEXT NOT NULL,
    CHECK(
      (state = 'NOT_STARTED' AND side_effect_identity IS NULL AND started_at IS NULL)
      OR
      (state IN ('STARTING', 'OUTCOME_RECORDED') AND side_effect_identity IS NOT NULL AND started_at IS NOT NULL)
    )
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_review_workflow_side_effect_identity
    ON review_workflow_command_side_effects(side_effect_identity)
    WHERE side_effect_identity IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS review_workflow_events (
    event_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_id           TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    batch_id              TEXT NOT NULL REFERENCES review_workflow_batches(batch_id),
    sequence              INTEGER NOT NULL CHECK(sequence > 0),
    aggregate_version     INTEGER NOT NULL CHECK(aggregate_version > 0),
    event_type            TEXT NOT NULL,
    command_id            TEXT NOT NULL UNIQUE
                          REFERENCES review_workflow_command_receipts(command_id),
    actor_execution_id    TEXT NOT NULL,
    payload_json          TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    UNIQUE(batch_id, sequence),
    UNIQUE(batch_id, aggregate_version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_events_workflow
    ON review_workflow_events(workflow_id, event_id)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_agent_assignments (
    assignment_id          TEXT PRIMARY KEY,
    workflow_id            TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    batch_id               TEXT,
    assigned_role          TEXT NOT NULL CHECK(assigned_role IN ('IMPLEMENTER', 'REVIEWER')),
    configured_agent_key   TEXT NOT NULL,
    configuration_hash     TEXT NOT NULL,
    payload_json           TEXT NOT NULL,
    record_hash            TEXT NOT NULL,
    created_at             TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_assignments_workflow
    ON review_workflow_agent_assignments(workflow_id, batch_id, assigned_role)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_actor_executions (
    actor_execution_id    TEXT PRIMARY KEY,
    assignment_id        TEXT,
    actor_type            TEXT NOT NULL CHECK(actor_type IN ('AGENT', 'HUMAN', 'CI', 'SYSTEM')),
    identity_assurance    TEXT NOT NULL CHECK(identity_assurance IN (
      'AUTHENTICATED_SUBJECT',
      'CLI_ASSERTED',
      'PROCESS_ATTESTED',
      'CONFIG_ONLY'
    )),
    payload_json          TEXT NOT NULL,
    record_hash           TEXT NOT NULL,
    created_at            TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_actor_assignment
    ON review_workflow_actor_executions(assignment_id)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_invocations (
    invocation_id       TEXT PRIMARY KEY,
    command_id          TEXT NOT NULL REFERENCES review_workflow_command_receipts(command_id),
    result_status       TEXT NOT NULL,
    payload_json        TEXT NOT NULL,
    record_hash         TEXT NOT NULL,
    created_at          TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_invocations_command
    ON review_workflow_invocations(command_id)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_sessions (
    session_identity_id              TEXT PRIMARY KEY,
    workflow_id                      TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    creating_invocation_id           TEXT NOT NULL
                                     REFERENCES review_workflow_invocations(invocation_id),
    resumed_from_session_identity_id TEXT
                                     REFERENCES review_workflow_sessions(session_identity_id),
    assigned_role                    TEXT NOT NULL
                                     CHECK(assigned_role IN ('IMPLEMENTER', 'REVIEWER')),
    provider_or_adapter              TEXT NOT NULL,
    vendor_session_id                TEXT NOT NULL,
    payload_json                     TEXT NOT NULL,
    record_hash                      TEXT NOT NULL,
    created_at                       TEXT NOT NULL,
    UNIQUE(workflow_id, provider_or_adapter, vendor_session_id)
  )`,

  `CREATE TABLE IF NOT EXISTS review_workflow_plan_documents (
    document_id       TEXT PRIMARY KEY,
    workflow_id       TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    batch_id          TEXT REFERENCES review_workflow_batches(batch_id),
    document_kind     TEXT NOT NULL CHECK(document_kind IN ('GENERAL', 'REFINED', 'BATCH')),
    version           INTEGER NOT NULL CHECK(version > 0),
    content_hash      TEXT NOT NULL,
    payload_json      TEXT NOT NULL,
    record_hash       TEXT NOT NULL,
    created_at        TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_review_workflow_plan_global_version
    ON review_workflow_plan_documents(workflow_id, document_kind, version)
    WHERE batch_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_review_workflow_plan_batch_version
    ON review_workflow_plan_documents(batch_id, document_kind, version)
    WHERE batch_id IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS review_workflow_plan_requirements (
    requirement_id           TEXT PRIMARY KEY,
    general_plan_version_id  TEXT NOT NULL
                             REFERENCES review_workflow_plan_documents(document_id),
    required                 INTEGER NOT NULL CHECK(required IN (0, 1)),
    payload_json             TEXT NOT NULL,
    record_hash              TEXT NOT NULL,
    created_at               TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_requirements_plan
    ON review_workflow_plan_requirements(general_plan_version_id)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_repository_audits (
    repository_audit_id  TEXT PRIMARY KEY,
    workflow_id          TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    head_sha             TEXT NOT NULL,
    actor_execution_id   TEXT NOT NULL,
    payload_json         TEXT NOT NULL,
    record_hash          TEXT NOT NULL,
    created_at           TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_audits_workflow
    ON review_workflow_repository_audits(workflow_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_acceptance_criteria (
    acceptance_criterion_id  TEXT PRIMARY KEY,
    batch_plan_version_id    TEXT NOT NULL
                             REFERENCES review_workflow_plan_documents(document_id),
    criterion_kind           TEXT NOT NULL,
    required                 INTEGER NOT NULL CHECK(required IN (0, 1)),
    status                   TEXT NOT NULL CHECK(status IN ('PENDING', 'PASSED', 'FAILED')),
    payload_json             TEXT NOT NULL,
    record_hash              TEXT NOT NULL,
    created_at               TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_criteria_plan
    ON review_workflow_acceptance_criteria(batch_plan_version_id, required, status)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_implementation_attempts (
    implementation_attempt_id       TEXT PRIMARY KEY,
    workflow_id                     TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    batch_id                        TEXT NOT NULL REFERENCES review_workflow_batches(batch_id),
    attempt_number                  INTEGER NOT NULL CHECK(attempt_number > 0),
    implementer_assignment_id       TEXT NOT NULL,
    implementer_actor_execution_id  TEXT NOT NULL,
    payload_json                    TEXT NOT NULL,
    record_hash                     TEXT NOT NULL,
    created_at                      TEXT NOT NULL,
    UNIQUE(batch_id, attempt_number)
  )`,

  `CREATE TABLE IF NOT EXISTS review_workflow_implementation_ready_evidence (
    implementation_ready_evidence_id  TEXT PRIMARY KEY,
    implementation_attempt_id         TEXT NOT NULL
                                      REFERENCES review_workflow_implementation_attempts(
                                        implementation_attempt_id
                                      ),
    actor_execution_id                TEXT NOT NULL,
    payload_json                      TEXT NOT NULL,
    record_hash                       TEXT NOT NULL,
    created_at                        TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS review_workflow_implementation_commits (
    resulting_commit_sha              TEXT PRIMARY KEY,
    implementation_attempt_id         TEXT NOT NULL UNIQUE
                                      REFERENCES review_workflow_implementation_attempts(
                                        implementation_attempt_id
                                      ),
    implementation_ready_evidence_id  TEXT NOT NULL
                                      REFERENCES review_workflow_implementation_ready_evidence(
                                        implementation_ready_evidence_id
                                      ),
    creator_actor_execution_id        TEXT NOT NULL,
    creation_mode                     TEXT NOT NULL
                                      CHECK(creation_mode IN ('AGENT_AUTHORIZED', 'HUMAN_CREATED')),
    payload_json                      TEXT NOT NULL,
    record_hash                       TEXT NOT NULL,
    created_at                        TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS review_workflow_handoff_transcripts (
    transcript_id             TEXT PRIMARY KEY,
    workflow_id               TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    batch_id                  TEXT REFERENCES review_workflow_batches(batch_id),
    contract_kind             TEXT NOT NULL CHECK(contract_kind IN (
      'REFINEMENT_RESULT',
      'REVIEW_RESULT',
      'IMPLEMENTATION_RESULT',
      'DISPOSITION_RESULT',
      'FINAL_AUDIT_RESULT'
    )),
    expected_schema_version   INTEGER NOT NULL CHECK(expected_schema_version > 0),
    actor_execution_id        TEXT NOT NULL,
    parse_status              TEXT NOT NULL CHECK(parse_status IN ('PARSED', 'REJECTED')),
    raw_transcript            TEXT NOT NULL,
    raw_transcript_hash       TEXT NOT NULL,
    payload_json              TEXT NOT NULL,
    record_hash               TEXT NOT NULL,
    created_at                TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_handoffs_batch
    ON review_workflow_handoff_transcripts(workflow_id, batch_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_handoffs_status
    ON review_workflow_handoff_transcripts(parse_status, created_at)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_structured_reviews (
    review_round_id             TEXT PRIMARY KEY,
    transcript_id               TEXT NOT NULL UNIQUE
                                REFERENCES review_workflow_handoff_transcripts(transcript_id),
    workflow_id                 TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    batch_id                    TEXT NOT NULL REFERENCES review_workflow_batches(batch_id),
    review_round_number         INTEGER NOT NULL CHECK(review_round_number > 0),
    review_kind                 TEXT NOT NULL CHECK(review_kind IN ('PLAN', 'CODE', 'FINAL_AUDIT')),
    verdict                     TEXT NOT NULL CHECK(verdict IN ('APPROVED', 'NEEDS_REVISION')),
    reviewer_actor_execution_id TEXT NOT NULL,
    payload_json                TEXT NOT NULL,
    record_hash                 TEXT NOT NULL,
    created_at                  TEXT NOT NULL,
    UNIQUE(batch_id, review_kind, review_round_number)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_structured_reviews_batch
    ON review_workflow_structured_reviews(batch_id, review_kind, review_round_number)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_findings (
    finding_id            TEXT PRIMARY KEY,
    workflow_id           TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    batch_id              TEXT NOT NULL REFERENCES review_workflow_batches(batch_id),
    review_round_id       TEXT NOT NULL,
    review_round_number   INTEGER NOT NULL CHECK(review_round_number > 0),
    review_kind           TEXT NOT NULL CHECK(review_kind IN ('PLAN', 'CODE', 'FINAL_AUDIT')),
    severity              TEXT NOT NULL,
    category              TEXT NOT NULL,
    status                TEXT NOT NULL,
    reviewed_commit_sha   TEXT,
    payload_json          TEXT NOT NULL,
    record_hash           TEXT NOT NULL,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_findings_round
    ON review_workflow_findings(batch_id, review_kind, review_round_number)`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_findings_status
    ON review_workflow_findings(batch_id, status, severity)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_dispositions (
    disposition_id          TEXT PRIMARY KEY,
    finding_id              TEXT NOT NULL REFERENCES review_workflow_findings(finding_id),
    disposition_kind        TEXT NOT NULL,
    reviewer_decision       TEXT NOT NULL CHECK(reviewer_decision IN (
      'PENDING',
      'ACCEPTED',
      'REJECTED'
    )),
    actor_execution_id      TEXT NOT NULL,
    payload_json            TEXT NOT NULL,
    record_hash             TEXT NOT NULL,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_dispositions_finding
    ON review_workflow_dispositions(finding_id, reviewer_decision)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_verification_records (
    verification_record_id       TEXT PRIMARY KEY,
    workflow_id                  TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    batch_id                     TEXT NOT NULL REFERENCES review_workflow_batches(batch_id),
    executor_actor_execution_id  TEXT NOT NULL,
    verification_type            TEXT NOT NULL,
    observed_status              TEXT NOT NULL,
    commit_sha                   TEXT NOT NULL,
    payload_json                 TEXT NOT NULL,
    record_hash                  TEXT NOT NULL,
    created_at                   TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_verification_batch
    ON review_workflow_verification_records(batch_id, commit_sha, verification_type)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_verification_attestations (
    verification_attestation_id  TEXT PRIMARY KEY,
    verification_record_id       TEXT NOT NULL
                                 REFERENCES review_workflow_verification_records(
                                   verification_record_id
                                 ),
    workflow_id                  TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    batch_id                     TEXT NOT NULL REFERENCES review_workflow_batches(batch_id),
    decision                     TEXT NOT NULL CHECK(decision IN ('ACCEPTED', 'REJECTED')),
    acceptance_mode              TEXT NOT NULL,
    attestor_actor_execution_id  TEXT NOT NULL,
    reviewed_commit_sha          TEXT NOT NULL,
    payload_json                 TEXT NOT NULL,
    record_hash                  TEXT NOT NULL,
    created_at                   TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_attestations_record
    ON review_workflow_verification_attestations(verification_record_id, decision)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_verification_baselines (
    baseline_id                    TEXT PRIMARY KEY,
    workflow_id                    TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    capture_batch_id               TEXT NOT NULL REFERENCES review_workflow_batches(batch_id),
    verification_record_id         TEXT NOT NULL UNIQUE
                                   REFERENCES review_workflow_verification_records(
                                     verification_record_id
                                   ),
    tool_name                      TEXT NOT NULL,
    tool_version                   TEXT NOT NULL,
    baseline_commit_sha            TEXT NOT NULL,
    configuration_hash             TEXT NOT NULL,
    normalizer_id                  TEXT NOT NULL,
    normalization_schema_version   INTEGER NOT NULL
                                   CHECK(normalization_schema_version > 0),
    finding_count                  INTEGER NOT NULL CHECK(finding_count >= 0),
    payload_json                   TEXT NOT NULL,
    record_hash                    TEXT NOT NULL,
    created_at                     TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_baselines_workflow
    ON review_workflow_verification_baselines(workflow_id, tool_name, created_at)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_verification_baseline_approvals (
    baseline_approval_id          TEXT PRIMARY KEY,
    baseline_id                   TEXT NOT NULL
                                  REFERENCES review_workflow_verification_baselines(baseline_id),
    workflow_id                   TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    decision                      TEXT NOT NULL CHECK(decision IN ('ACCEPTED', 'REJECTED')),
    reviewer_actor_execution_id   TEXT NOT NULL,
    payload_json                  TEXT NOT NULL,
    record_hash                   TEXT NOT NULL,
    created_at                    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_baseline_approvals
    ON review_workflow_verification_baseline_approvals(baseline_id, decision, created_at)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_verification_baseline_comparisons (
    comparison_id                  TEXT PRIMARY KEY,
    workflow_id                    TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    batch_id                       TEXT NOT NULL REFERENCES review_workflow_batches(batch_id),
    baseline_id                    TEXT NOT NULL
                                   REFERENCES review_workflow_verification_baselines(baseline_id),
    baseline_approval_id           TEXT NOT NULL
                                   REFERENCES review_workflow_verification_baseline_approvals(
                                     baseline_approval_id
                                   ),
    current_verification_record_id TEXT NOT NULL
                                   REFERENCES review_workflow_verification_records(
                                     verification_record_id
                                   ),
    result                         TEXT NOT NULL
                                   CHECK(result IN ('PASSED', 'FAILED', 'INCOMPARABLE')),
    current_commit_sha             TEXT NOT NULL,
    introduced_count               INTEGER,
    resolved_count                 INTEGER,
    unchanged_count                INTEGER,
    payload_json                   TEXT NOT NULL,
    record_hash                    TEXT NOT NULL,
    created_at                     TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_baseline_comparisons
    ON review_workflow_verification_baseline_comparisons(
      batch_id,
      current_commit_sha,
      result
    )`,

  `CREATE TABLE IF NOT EXISTS review_workflow_baseline_comparison_attestations (
    comparison_attestation_id     TEXT PRIMARY KEY,
    comparison_id                 TEXT NOT NULL
                                  REFERENCES review_workflow_verification_baseline_comparisons(
                                    comparison_id
                                  ),
    workflow_id                   TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    batch_id                      TEXT NOT NULL REFERENCES review_workflow_batches(batch_id),
    decision                      TEXT NOT NULL CHECK(decision IN ('ACCEPTED', 'REJECTED')),
    reviewer_actor_execution_id   TEXT NOT NULL,
    reviewed_commit_sha           TEXT NOT NULL,
    payload_json                  TEXT NOT NULL,
    record_hash                   TEXT NOT NULL,
    created_at                    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_baseline_comparison_attestations
    ON review_workflow_baseline_comparison_attestations(comparison_id, decision, created_at)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_batch_role_sessions (
    batch_id             TEXT NOT NULL REFERENCES review_workflow_batches(batch_id),
    role                 TEXT NOT NULL CHECK(role IN ('IMPLEMENTER', 'REVIEWER')),
    workflow_id          TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    session_identity_id  TEXT NOT NULL,
    provider_or_adapter  TEXT NOT NULL,
    vendor_session_id    TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    PRIMARY KEY (batch_id, role),
    UNIQUE (provider_or_adapter, vendor_session_id)
  )`,

  `CREATE TABLE IF NOT EXISTS review_workflow_session_continuity (
    invocation_id                 TEXT PRIMARY KEY,
    workflow_id                   TEXT NOT NULL,
    batch_id                      TEXT NOT NULL,
    role                          TEXT NOT NULL CHECK(role IN ('IMPLEMENTER', 'REVIEWER')),
    adapter_kind                  TEXT NOT NULL,
    requested_vendor_session_id   TEXT,
    returned_vendor_session_id    TEXT,
    outcome                       TEXT NOT NULL CHECK(outcome IN ('CREATED', 'RESUMED', 'FAILED')),
    error_code                    TEXT,
    created_at                    TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_session_continuity_batch
    ON review_workflow_session_continuity(batch_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_jobs (
    job_id            TEXT PRIMARY KEY,
    workflow_id       TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    batch_id          TEXT NOT NULL REFERENCES review_workflow_batches(batch_id),
    job_type          TEXT NOT NULL CHECK(job_type IN ('CODE_REVIEW', 'FINAL_AUDIT', 'VERIFICATION')),
    command_id        TEXT NOT NULL UNIQUE,
    expected_receipt_json TEXT NOT NULL,
    status            TEXT NOT NULL CHECK(status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
    attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    max_attempts      INTEGER NOT NULL CHECK(max_attempts > 0),
    payload_json      TEXT NOT NULL,
    result_json       TEXT,
    error_code        TEXT,
    error_message     TEXT,
    worker_id         TEXT,
    lease_expires_at  TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_jobs_claimable
    ON review_workflow_jobs(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_jobs_workflow
    ON review_workflow_jobs(workflow_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS review_workflow_event_cursors (
    cursor_id      TEXT PRIMARY KEY,
    workflow_id    TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    last_event_id  INTEGER NOT NULL DEFAULT 0 CHECK(last_event_id >= 0),
    updated_at     TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS review_workflow_review_range_evidence (
    review_range_evidence_id  TEXT PRIMARY KEY,
    workflow_id               TEXT NOT NULL REFERENCES review_workflows(workflow_id),
    batch_id                  TEXT NOT NULL REFERENCES review_workflow_batches(batch_id),
    current_implementation_sha TEXT NOT NULL,
    patch_hash                TEXT NOT NULL,
    payload_json              TEXT NOT NULL,
    record_hash               TEXT NOT NULL,
    created_at                TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_review_workflow_ranges_batch
    ON review_workflow_review_range_evidence(batch_id, current_implementation_sha)`,

  // History/evidence tables are append-only. Lifecycle snapshots such as findings,
  // dispositions, sessions, and attestations remain updateable for later batches.
  ...[
    'review_workflow_events',
    'review_workflow_agent_assignments',
    'review_workflow_plan_documents',
    'review_workflow_plan_requirements',
    'review_workflow_repository_audits',
    'review_workflow_implementation_ready_evidence',
    'review_workflow_implementation_commits',
    'review_workflow_handoff_transcripts',
    'review_workflow_structured_reviews',
    'review_workflow_verification_records',
    'review_workflow_verification_baselines',
    'review_workflow_verification_baseline_approvals',
    'review_workflow_verification_baseline_comparisons',
    'review_workflow_baseline_comparison_attestations',
    'review_workflow_review_range_evidence',
    'review_workflow_batch_role_sessions',
    'review_workflow_session_continuity',
  ].flatMap((table) => [
    `CREATE TRIGGER IF NOT EXISTS ${table}_immutable_update
      BEFORE UPDATE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, '${table} is immutable');
      END`,
    `CREATE TRIGGER IF NOT EXISTS ${table}_immutable_delete
      BEFORE DELETE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, '${table} is immutable');
      END`,
  ]),
] as const;
