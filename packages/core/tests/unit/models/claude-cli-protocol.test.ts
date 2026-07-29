import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ClaudeCliProtocolError,
  SUPPORTED_CLAUDE_CLI_VERSION_RANGE,
  isSupportedClaudeCliVersion,
  parseClaudeCliStream,
} from '../../../src/models/claude-cli-protocol.js';

const FIXTURE_DIRECTORY = new URL('../../fixtures/claude-cli/', import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIRECTORY), 'utf8');
}

describe('parseClaudeCliStream', () => {
  it('parses the documented init/result contract and exact SDK usage', () => {
    const result = parseClaudeCliStream(fixture('success.jsonl'));

    expect(result).toEqual({
      text: 'Fixture response',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      durationMs: 1250,
      cliVersion: '2.1.218',
      workingDirectory: '/fixture/repository',
      reportedModel: 'claude-sonnet-4-6',
      permissionMode: 'acceptEdits',
      authenticationSource: 'subscription',
      usage: {
        inputTokens: 115,
        outputTokens: 20,
        totalTokens: 135,
        costUsd: 0.0125,
      },
    });
  });

  it('rejects a structured error result instead of treating process exit zero as success', () => {
    expect(() => parseClaudeCliStream(fixture('error.jsonl'))).toThrow(
      'Claude CLI reported unsuccessful result error_during_execution',
    );
  });

  it('rejects malformed JSONL without inferring a result from later lines', () => {
    expect(() => parseClaudeCliStream(fixture('malformed.jsonl'))).toThrow(
      'Malformed Claude CLI JSONL at line 2',
    );
  });

  it('rejects mismatched session identities', () => {
    const output = fixture('success.jsonl').replace(
      '"session_id":"550e8400-e29b-41d4-a716-446655440000","total_cost_usd"',
      '"session_id":"different-session","total_cost_usd"',
    );

    expect(() => parseClaudeCliStream(output)).toThrow('session IDs do not match');
  });

  it('requires init and result messages', () => {
    expect(() => parseClaudeCliStream('')).toThrow('missing its system/init message');
    expect(() => parseClaudeCliStream(fixture('success.jsonl').split('\n')[0] ?? '')).toThrow(
      'missing its final result message',
    );
  });

  it('enforces the supported Claude CLI major/minor contract', () => {
    expect(SUPPORTED_CLAUDE_CLI_VERSION_RANGE).toBe('>=2.1.0 <3.0.0');
    expect(isSupportedClaudeCliVersion('2.1.0')).toBe(true);
    expect(isSupportedClaudeCliVersion('2.1.0+build.1')).toBe(true);
    expect(isSupportedClaudeCliVersion('2.1.0-beta.1')).toBe(false);
    expect(isSupportedClaudeCliVersion('2.1.218')).toBe(true);
    expect(isSupportedClaudeCliVersion('2.9.0-beta.1')).toBe(true);
    expect(isSupportedClaudeCliVersion('2.0.99')).toBe(false);
    expect(isSupportedClaudeCliVersion('3.0.0')).toBe(false);
    expect(isSupportedClaudeCliVersion('not-a-version')).toBe(false);

    const unsupported = fixture('success.jsonl').replace('2.1.218', '3.0.0');
    expect(() => parseClaudeCliStream(unsupported)).toThrow(ClaudeCliProtocolError);
  });
});
