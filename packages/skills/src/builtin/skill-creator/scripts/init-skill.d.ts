export interface InitSkillOptions {
  name: string;
  baseDir?: string;
  description?: string;
  force?: boolean;
  includeEvals?: boolean;
}

export function renderSkillTemplate(name: string, description: string): string;
export function renderEvalTemplate(name: string): string;
export function initSkill(options: InitSkillOptions): Promise<{
  skillDir: string;
  created: string[];
}>;
