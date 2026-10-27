export type KodaXSkillInvocationErrorCode =
  | 'skill_not_found'
  | 'skill_not_registered'
  | 'skill_registry_unavailable'
  | 'skill_policy_restore_failed';

const REASONS: Readonly<Record<KodaXSkillInvocationErrorCode, string>> = {
  skill_not_found: 'the Skill was not found in trusted discovery sources.',
  skill_not_registered: 'the Skill is not registered in the trusted Host registry.',
  skill_registry_unavailable: 'the trusted Skill registry could not be fully loaded.',
  skill_policy_restore_failed: 'the trusted Skill policy could not be restored.',
};

/** Local preparation failure; raw filesystem errors stay in the private cause. */
export class KodaXSkillInvocationError extends Error {
  readonly source = 'local';
  readonly stage: 'skill_load' | 'skill_policy';
  readonly skillName: string;

  constructor(readonly code: KodaXSkillInvocationErrorCode, name: string, options?: ErrorOptions) {
    const skillName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name) ? name : 'unknown';
    super(`Skill "${skillName}" could not be prepared: ${REASONS[code]}`, options);
    this.name = 'KodaXSkillInvocationError';
    this.skillName = skillName;
    this.stage = code === 'skill_policy_restore_failed' ? 'skill_policy' : 'skill_load';
  }
}
