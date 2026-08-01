// Real-command coverage for `codemoot workflow preflight`.
//
// The pre-flight is a GATE, and a gate that cannot fail is worse than no gate at all: it
// would report "ok" for the exact contract-shape defects it exists to catch. So both
// outcomes are proven here — a valid document passes, and an invalid one fails, names the
// rejection, and writes the response to disk.
//
// It also asserts the two properties that give the gate its meaning: the prompt carries the
// instruction generated from the REAL schema, and the answer is judged by the REAL parser.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewWorkflowContracts } from '@codemoot/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PREFLIGHT_CASES,
  reviewWorkflowPreflightCommand,
} from '../src/commands/review-workflow.js';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-scripted.mjs', import.meta.url));

function buildConfig(): string {
  return JSON.stringify({
    configVersion: 3,
    workflow: 'review-gated-batches',
    models: {
      implementer: {
        provider: 'anthropic',
        model: 'claude-supported',
        cliAdapter: {
          kind: 'claude',
          command: process.execPath,
          args: [FAKE_CLAUDE],
          timeout: 120,
          envAllowlist: ['CODEMOOT_FAKE_RESPONSE_FILE'],
        },
      },
      reviewer: {
        provider: 'anthropic',
        model: 'claude-reviewer',
        cliAdapter: {
          kind: 'claude',
          command: process.execPath,
          args: [FAKE_CLAUDE],
          timeout: 120,
          envAllowlist: ['CODEMOOT_FAKE_RESPONSE_FILE'],
        },
      },
    },
    roles: { implementer: { model: 'implementer' }, reviewer: { model: 'reviewer' } },
    reviewGated: {
      identity: {
        minimumAssurance: 'process_attested',
        requireDifferentAdapterKinds: false,
        prohibitSharedSessions: true,
      },
      commit: { mode: 'either', agentMayCommit: true },
    },
    debate: { enabled: false },
  });
}

describe('codemoot workflow preflight (real command, scripted adapter)', () => {
  let projectDir: string;
  let responseFile: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'codemoot-preflight-'));
    responseFile = join(projectDir, 'response.json');
    writeFileSync(join(projectDir, '.cowork.yml'), buildConfig());
    process.env.CODEMOOT_FAKE_RESPONSE_FILE = responseFile;
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    Reflect.deleteProperty(process.env, 'CODEMOOT_FAKE_RESPONSE_FILE');
    process.exitCode = undefined;
    rmSync(projectDir, { recursive: true, force: true });
  });

  /** The single JSON object the command printed. */
  function printed(): {
    ok: boolean;
    results: readonly {
      contract: string;
      ok: boolean;
      rejection?: string;
      rejectedResponse?: string;
    }[];
  } {
    const last = logSpy.mock.calls.at(-1)?.[0];
    return JSON.parse(String(last));
  }

  it('passes when the model returns a document the real parser accepts', async () => {
    // The proven example is exactly what a correct model response looks like.
    writeFileSync(
      responseFile,
      JSON.stringify(reviewWorkflowContracts.CONTRACT_EXAMPLES.BATCH_PLAN_RESULT),
    );
    await reviewWorkflowPreflightCommand({});
    const output = printed();
    expect(output.ok).toBe(true);
    expect(output.results).toHaveLength(1);
    expect(output.results[0]?.contract).toBe('BATCH_PLAN_RESULT');
    expect(process.exitCode).toBeUndefined();
  });

  it('fails, explains the rejection, and saves the response when the shape is wrong', async () => {
    // The EXACT defect that killed run 8: a discriminated union the model guessed at.
    const broken = structuredClone(
      reviewWorkflowContracts.CONTRACT_EXAMPLES.BATCH_PLAN_RESULT,
    ) as Record<string, Record<string, unknown>>;
    broken.batchPlan.browserAcceptanceCriteria = { criterionIds: [] };
    writeFileSync(responseFile, JSON.stringify(broken));

    await reviewWorkflowPreflightCommand({});
    const output = printed();
    expect(output.ok).toBe(false);
    // A non-zero exit is what lets the gate be chained before `workflow run`.
    expect(process.exitCode).toBe(1);
    const result = output.results[0];
    expect(result?.rejection).toContain('applicability');
    // The response is on disk: a blind rejection is the failure mode this command ends.
    expect(result?.rejectedResponse).toBeDefined();
    expect(existsSync(String(result?.rejectedResponse))).toBe(true);
    expect(JSON.parse(readFileSync(String(result?.rejectedResponse), 'utf8'))).toEqual(broken);
  });

  it('asks and judges with the SAME schema and parser the workflow uses', () => {
    // Parity by identity, which is the whole claim: a pre-flight built on a lookalike
    // schema — or judged by a lookalike parser — would pass while the real run still
    // failed, which is precisely the false confidence this command must not create.
    const EXPECTED = {
      BATCH_PLAN_RESULT: [
        reviewWorkflowContracts.batchPlanContractSchema,
        reviewWorkflowContracts.parseBatchPlanResult,
      ],
      REFINEMENT_OUTLINE_RESULT: [
        reviewWorkflowContracts.refinementOutlineContractSchema,
        reviewWorkflowContracts.parseRefinementOutline,
      ],
      REVIEW_RESULT: [
        reviewWorkflowContracts.reviewResultContractSchema,
        reviewWorkflowContracts.parseReviewResult,
      ],
      IMPLEMENTATION_RESULT: [
        reviewWorkflowContracts.implementationResultContractSchema,
        reviewWorkflowContracts.parseImplementationResult,
      ],
      DISPOSITION_RESULT: [
        reviewWorkflowContracts.dispositionResultContractSchema,
        reviewWorkflowContracts.parseDispositionResult,
      ],
      FINAL_AUDIT_RESULT: [
        reviewWorkflowContracts.finalAuditResultContractSchema,
        reviewWorkflowContracts.parseFinalAuditResult,
      ],
    } as const;
    for (const entry of PREFLIGHT_CASES) {
      const expected = EXPECTED[entry.contractKind as keyof typeof EXPECTED];
      expect(expected, entry.contractKind).toBeDefined();
      expect(entry.schema, entry.contractKind).toBe(expected[0]);
      expect(entry.parse, entry.contractKind).toBe(expected[1]);
    }
  });

  it('rejects an unknown contract instead of silently checking nothing', async () => {
    await expect(reviewWorkflowPreflightCommand({ contract: 'NOT_A_CONTRACT' })).rejects.toThrow(
      /Unknown contract/,
    );
  });

  it('covers every contract an agent is actually asked to produce', async () => {
    // REFINEMENT_RESULT is assembled locally from the outline and per-batch plans, so no
    // agent ever produces one — everything else must be pre-flightable.
    writeFileSync(
      responseFile,
      JSON.stringify(reviewWorkflowContracts.CONTRACT_EXAMPLES.REFINEMENT_OUTLINE_RESULT),
    );
    await reviewWorkflowPreflightCommand({ contract: 'all' });
    const covered = printed().results.map((result) => result.contract);
    expect(covered).toEqual([
      'BATCH_PLAN_RESULT',
      'REFINEMENT_OUTLINE_RESULT',
      'REVIEW_RESULT',
      'IMPLEMENTATION_RESULT',
      'DISPOSITION_RESULT',
      'FINAL_AUDIT_RESULT',
    ]);
  });
});
