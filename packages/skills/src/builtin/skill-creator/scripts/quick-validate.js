#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkill } from './utils.js';

const ALLOWED_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
  'disable-model-invocation',
  'user-invocable',
  'argument-hint',
  'context',
  'agent',
  'model',
  'hooks',
]);

export async function validateSkillDirectory(skillDir) {
  const result = {
    valid: false,
    errors: [],
    warnings: [],
    frontmatter: null,
  };

  let skill;
  try {
    skill = await loadSkill(skillDir);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }

  const { frontmatter, body } = skill;
  result.frontmatter = frontmatter;

  const unexpectedKeys = Object.keys(frontmatter).filter((key) => !ALLOWED_FRONTMATTER_KEYS.has(key));
  if (unexpectedKeys.length > 0) {
    result.errors.push(
      `Unexpected frontmatter keys: ${unexpectedKeys.sort().join(', ')}`
    );
  }

  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const description = typeof frontmatter.description === 'string'
    ? frontmatter.description.trim()
    : '';

  if (!name) {
    result.errors.push('Missing required frontmatter field: name');
  } else {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      result.errors.push(
        `Invalid skill name "${name}". Use lowercase kebab-case and avoid consecutive hyphens.`
      );
    }
    if (name.length > 64) {
      result.errors.push(`Skill name is too long (${name.length}/64).`);
    }

    const dirName = path.basename(path.resolve(skillDir));
    if (dirName !== name) {
      result.warnings.push(
        `Skill directory name "${dirName}" does not match frontmatter name "${name}".`
      );
    }
  }

  if (!description) {
    result.errors.push('Missing required frontmatter field: description');
  } else {
    if (description.length > 1024) {
      result.errors.push(`Description is too long (${description.length}/1024).`);
    }
    if (/[<>]/.test(description)) {
      result.errors.push('Description cannot contain angle brackets.');
    }
    if (!/[。.!?]/.test(description)) {
      result.warnings.push('Description may be too terse; consider making the trigger conditions clearer.');
    }
  }

  if (!body.trim()) {
    result.errors.push('SKILL.md body is empty.');
  }

  if (frontmatter.compatibility != null) {
    if (typeof frontmatter.compatibility !== 'string') {
      result.errors.push('compatibility must be a string if provided.');
    } else if (frontmatter.compatibility.length > 500) {
      result.errors.push(`compatibility is too long (${frontmatter.compatibility.length}/500).`);
    }
  }

  if (frontmatter['allowed-tools'] != null) {
    const allowedTools = frontmatter['allowed-tools'];
    const validAllowedTools = typeof allowedTools === 'string'
      || (Array.isArray(allowedTools) && allowedTools.every((item) => typeof item === 'string'));
    if (!validAllowedTools) {
      result.errors.push('allowed-tools must be a string or string array.');
    }
  }

  if (frontmatter['disable-model-invocation'] != null
      && typeof frontmatter['disable-model-invocation'] !== 'boolean') {
    result.errors.push('disable-model-invocation must be a boolean.');
  }

  if (frontmatter['user-invocable'] != null && typeof frontmatter['user-invocable'] !== 'boolean') {
    result.errors.push('user-invocable must be a boolean.');
  }

  if (frontmatter.context != null && frontmatter.context !== 'fork') {
    result.errors.push('context must be "fork" when provided.');
  }

  if (frontmatter.hooks != null && (typeof frontmatter.hooks !== 'object' || Array.isArray(frontmatter.hooks))) {
    result.errors.push('hooks must be an object when provided.');
  }

  result.valid = result.errors.length === 0;
  return result;
}

async function main() {
  const skillDir = process.argv[2];
  if (!skillDir) {
    console.error('Usage: node scripts/quick-validate.js <skill-directory>');
    process.exit(1);
  }

  const result = await validateSkillDirectory(skillDir);

  if (result.errors.length === 0) {
    console.log('Skill is valid.');
  } else {
    console.error('Skill validation failed:');
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log('Warnings:');
    for (const warning of result.warnings) {
      console.log(`- ${warning}`);
    }
  }

  process.exit(result.valid ? 0 : 1);
}

const isDirectRun = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
