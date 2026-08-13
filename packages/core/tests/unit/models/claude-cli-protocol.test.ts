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
      resultMessageCount: 1,
      usage: {
        inputTokens: 115,
        outputTokens: 20,
        totalTokens: 135,
        costUsd: 0.0125,
      },
    });
  });

  it('tolerates a REPEATED result — the last one wins, exactly like repeated init', () => {
    // A live ~60-minute implementer call (CLI 2.1.229) emitted two result messages on the
    // same session refresh/compaction boundary that repeats init, and the old
    // single-result rule threw the whole call away AFTER the work was committed. The last
    // result is authoritative (final text, usage, stop reason); the count is surfaced so
    // the boundary is visible.
    const lines = fixture('success.jsonl').trimEnd().split('\n');
    const finalResult = lines.at(-1) ?? '';
    const supersededResult = finalResult.replace('Fixture response', 'SUPERSEDED EARLY RESULT');
    const repeated = [...lines.slice(0, -1), supersededResult, finalResult].join('\n');
    const parsed = parseClaudeCliStream(repeated);
    expect(parsed.text).toBe('Fixture response'); // the LAST result's text, not the first
    expect(parsed.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(parsed.resultMessageCount).toBe(2);
  });

  it('still rejects a repeated result whose session NO init announced — corruption stays fatal', () => {
    const lines = fixture('success.jsonl').trimEnd().split('\n');
    const finalResult = lines.at(-1) ?? '';
    const foreignResult = finalResult.replace(
      '550e8400-e29b-41d4-a716-446655440000',
      'never-announced-session',
    );
    // The foreign result is SUPERSEDED by a valid final one — it must still be fatal:
    // an unannounced session anywhere in the stream is the real corruption signal.
    const corrupted = [...lines.slice(0, -1), foreignResult, finalResult].join('\n');
    expect(() => parseClaudeCliStream(corrupted)).toThrow('matches none of the announced');
  });

  it('still rejects a malformed repeated result — every result must parse', () => {
    const lines = fixture('success.jsonl').trimEnd().split('\n');
    const finalResult = lines.at(-1) ?? '';
    const malformedResult = finalResult.replace('"is_error":false,', '');
    const stream = [...lines.slice(0, -1), malformedResult, finalResult].join('\n');
    expect(() => parseClaudeCliStream(stream)).toThrow('Invalid Claude CLI result message');
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

  it('rejects a result session that NO init ever announced', () => {
    // The corruption check, restated precisely: a foreign result is corruption; a long
    // session announcing itself again is not.
    const output = fixture('success.jsonl').replace(
      '"session_id":"550e8400-e29b-41d4-a716-446655440000","total_cost_usd"',
      '"session_id":"different-session","total_cost_usd"',
    );

    expect(() => parseClaudeCliStream(output)).toThrow('matches none of the announced');
  });

  it('tolerates a REPEATED init — long sessions refresh, and that is not corruption', () => {
    // A live 28-minute reviewer call emitted two init messages (session refresh /
    // compaction boundary) and the old single-init rule threw the whole call away AFTER
    // the work was done. Metadata comes from the first init.
    const lines = fixture('success.jsonl').trimEnd().split('\n');
    const firstInit = lines[0] ?? '';
    const repeated = [firstInit, firstInit, ...lines.slice(1)].join('\n');
    const parsed = parseClaudeCliStream(repeated);
    expect(parsed.sessionId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('accepts a session that ROLLS: a later init announces the id the result carries', () => {
    const lines = fixture('success.jsonl').trimEnd().split('\n');
    const firstInit = lines[0] ?? '';
    const rolledInit = firstInit.replace(
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440099',
    );
    const rolledResult = (lines.at(-1) ?? '').replace(
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440099',
    );
    const rolled = [firstInit, rolledInit, ...lines.slice(1, -1), rolledResult].join('\n');
    const parsed = parseClaudeCliStream(rolled);
    // The RESULT's session is authoritative for resume — the rolled id, not the first.
    expect(parsed.sessionId).toBe('550e8400-e29b-41d4-a716-446655440099');
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
