import type { ActorType, Authority, CommitPolicy } from '../review-workflow/types.js';
import type { AuthorityGrantSnapshot } from './types.js';

export function createAuthorityGrantSnapshot(commitPolicy: CommitPolicy): AuthorityGrantSnapshot[] {
  const commitActorTypes: ActorType[] =
    commitPolicy === 'HUMAN_REQUIRED'
      ? ['HUMAN']
      : commitPolicy === 'AGENT_AUTHORIZED'
        ? ['AGENT']
        : ['AGENT', 'HUMAN'];
  const grants: ReadonlyArray<{
    authority: Authority;
    permittedActorTypes: ActorType[];
    assignedRole?: 'IMPLEMENTER' | 'REVIEWER';
  }> = [
    { authority: 'WORKFLOW_OWNER', permittedActorTypes: ['HUMAN'] },
    { authority: 'PLAN_REFINER', permittedActorTypes: ['AGENT', 'HUMAN'] },
    {
      authority: 'IMPLEMENTER',
      permittedActorTypes: ['AGENT'],
      assignedRole: 'IMPLEMENTER',
    },
    { authority: 'COMMIT_CREATOR', permittedActorTypes: commitActorTypes },
    { authority: 'REVIEWER', permittedActorTypes: ['AGENT'], assignedRole: 'REVIEWER' },
    {
      authority: 'VERIFICATION_EXECUTOR',
      permittedActorTypes: ['AGENT', 'HUMAN', 'CI', 'SYSTEM'],
    },
    {
      authority: 'VERIFICATION_ATTESTOR',
      permittedActorTypes: ['AGENT', 'HUMAN', 'CI', 'SYSTEM'],
    },
    { authority: 'MERGE_RECORDER', permittedActorTypes: ['HUMAN', 'CI'] },
    { authority: 'SYSTEM_RECONCILER', permittedActorTypes: ['SYSTEM'] },
  ];
  return grants.map((grant) => ({
    ...grant,
    permittedActorTypes: [...grant.permittedActorTypes],
  }));
}

export function authorityGrantSnapshotMatchesPolicy(
  actual: readonly AuthorityGrantSnapshot[],
  commitPolicy: CommitPolicy,
): boolean {
  const expected = createAuthorityGrantSnapshot(commitPolicy);
  if (actual.length !== expected.length) return false;
  return expected.every((expectedGrant) => {
    const actualGrant = actual.find((candidate) => candidate.authority === expectedGrant.authority);
    return (
      actualGrant !== undefined &&
      actualGrant.assignedRole === expectedGrant.assignedRole &&
      sameValues(actualGrant.permittedActorTypes, expectedGrant.permittedActorTypes)
    );
  });
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}
