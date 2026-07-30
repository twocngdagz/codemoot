import type { VerificationCommandSpec } from '../review-workflow/types.js';
import type { BaselineIncompatibilityCode, VerificationBaseline } from './types.js';

export interface BaselineComparisonCandidate {
  readonly currentCommand: VerificationCommandSpec;
  readonly currentToolName: string;
  readonly currentToolVersion?: string;
  readonly currentConfigurationInputPaths: readonly string[];
  readonly currentConfigurationHash: string;
  readonly normalizerId: string;
  readonly normalizationSchemaVersion: number;
}

export function collectBaselineIncompatibilities(
  baseline: VerificationBaseline,
  current: BaselineComparisonCandidate,
): readonly BaselineIncompatibilityCode[] {
  const reasons: BaselineIncompatibilityCode[] = [];
  if (!sameCommand(baseline.command, current.currentCommand)) {
    reasons.push('COMMAND_MISMATCH');
  }
  if (baseline.toolName !== current.currentToolName) {
    reasons.push('TOOL_NAME_MISMATCH');
  }
  if (baseline.toolVersion !== current.currentToolVersion) {
    reasons.push('TOOL_VERSION_MISMATCH');
  }
  if (
    !sameStrings(
      [...baseline.configurationInputPaths].sort(),
      [...current.currentConfigurationInputPaths].sort(),
    )
  ) {
    reasons.push('CONFIGURATION_INPUTS_MISMATCH');
  }
  if (baseline.configurationHash !== current.currentConfigurationHash) {
    reasons.push('CONFIGURATION_HASH_MISMATCH');
  }
  if (
    baseline.normalizerId !== current.normalizerId ||
    baseline.normalizationSchemaVersion !== current.normalizationSchemaVersion
  ) {
    reasons.push('NORMALIZER_MISMATCH');
  }
  return reasons;
}

function sameCommand(left: VerificationCommandSpec, right: VerificationCommandSpec): boolean {
  return (
    left.executable === right.executable &&
    sameStrings(left.arguments, right.arguments) &&
    left.workingDirectory === right.workingDirectory &&
    left.verificationType === right.verificationType &&
    sameStrings([...left.relatedCriterionIds].sort(), [...right.relatedCriterionIds].sort())
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
