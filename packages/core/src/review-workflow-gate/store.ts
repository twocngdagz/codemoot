// Read model for gate evaluation: findings, dispositions, records, attestations, reviews.

import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ReviewWorkflowPersistenceError } from '../memory/review-workflow-store.js';
import { structuredReviewSchema } from '../review-workflow-contracts/schemas.js';
import type { StructuredReview } from '../review-workflow-contracts/types.js';
import { ReviewWorkflowImplementationStore } from '../review-workflow-implementation/store.js';
import {
  findingSchema,
  verificationAttestationSchema,
  verificationRecordSchema,
} from '../review-workflow/schemas.js';
import type {
  Finding,
  VerificationAttestation,
  VerificationRecord,
} from '../review-workflow/types.js';

const payloadRowSchema = z.object({ payload_json: z.string() });

export class ReviewWorkflowGateStore extends ReviewWorkflowImplementationStore {
  private readonly gateDb: Database.Database;

  constructor(db: Database.Database) {
    super(db);
    this.gateDb = db;
  }

  listBatchFindings(batchId: string): readonly Finding[] {
    return this.readGatePayloads(
      `SELECT payload_json
       FROM review_workflow_findings
       WHERE batch_id = ?
       ORDER BY created_at, finding_id`,
      [batchId],
      findingSchema,
      'FINDING',
    );
  }

  listVerificationRecords(batchId: string): readonly VerificationRecord[] {
    return this.readGatePayloads(
      `SELECT payload_json
       FROM review_workflow_verification_records
       WHERE batch_id = ?
       ORDER BY created_at, verification_record_id`,
      [batchId],
      verificationRecordSchema,
      'VERIFICATION_RECORD',
    );
  }

  listAttestationsForRecord(verificationRecordId: string): readonly VerificationAttestation[] {
    return this.readGatePayloads(
      `SELECT payload_json
       FROM review_workflow_verification_attestations
       WHERE verification_record_id = ?
       ORDER BY created_at, verification_attestation_id`,
      [verificationRecordId],
      verificationAttestationSchema,
      'VERIFICATION_ATTESTATION',
    );
  }

  listPlanRequirementIds(generalPlanVersionId: string): readonly string[] {
    const rows = this.gateDb
      .prepare(
        `SELECT requirement_id
         FROM review_workflow_plan_requirements
         WHERE general_plan_version_id = ?
         ORDER BY requirement_id`,
      )
      .all(generalPlanVersionId);
    return rows.map((row) => z.object({ requirement_id: z.string() }).parse(row).requirement_id);
  }

  listFinalAudits(batchId: string): readonly StructuredReview[] {
    return this.readGatePayloads(
      `SELECT payload_json
       FROM review_workflow_structured_reviews
       WHERE batch_id = ? AND review_kind = 'FINAL_AUDIT'
       ORDER BY review_round_number`,
      [batchId],
      structuredReviewSchema,
      'STRUCTURED_REVIEW',
    );
  }

  private readGatePayloads<Value>(
    sql: string,
    values: readonly unknown[],
    schema: z.ZodType<Value>,
    kind: string,
  ): readonly Value[] {
    return this.gateDb
      .prepare(sql)
      .all(...values)
      .map((row) => {
        try {
          return schema.parse(JSON.parse(payloadRowSchema.parse(row).payload_json));
        } catch {
          throw new ReviewWorkflowPersistenceError(
            'PERSISTED_DATA_INVALID',
            `Stored ${kind} payload failed domain validation`,
          );
        }
      });
  }
}
