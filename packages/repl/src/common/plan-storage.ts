/**
 * Plan Mode 计划存储
 */

import path from 'path';
import fs from 'fs/promises';
import { KODAX_DIR } from './utils.js';

export interface ExecutionPlan {
  id: string;
  title: string;
  originalPrompt: string;
  steps: {
    id: string;
    description: string;
    tool?: string;
    input?: Record<string, unknown>;
    status: 'pending' | 'done' | 'skipped' | 'failed';
    executedAt?: string;
  }[];
  createdAt: string;
  updatedAt: string;
}

export class PlanStorage {
  private dir = path.join(KODAX_DIR, 'plans');

  async save(plan: ExecutionPlan): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const filePath = path.join(this.dir, `${plan.id}.json`);
    plan.updatedAt = new Date().toISOString();
    await fs.writeFile(filePath, JSON.stringify(plan, null, 2));
  }

  async load(planId: string): Promise<ExecutionPlan | null> {
    try {
      const filePath = path.join(this.dir, `${planId}.json`);
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  async list(): Promise<ExecutionPlan[]> {
    try {
      const files = await fs.readdir(this.dir);
      const plans = await Promise.all(
        files
          .filter(f => f.endsWith('.json'))
          .map(f => this.load(f.replace('.json', '')))
      );
      return plans.filter((p): p is ExecutionPlan => p !== null);
    } catch {
      return [];
    }
  }

  async findPending(): Promise<ExecutionPlan | null> {
    const plans = await this.list();
    return plans.find(p =>
      p.steps.some(s => s.status === 'pending')
    ) || null;
  }

  async delete(planId: string): Promise<void> {
    const filePath = path.join(this.dir, `${planId}.json`);
    await fs.unlink(filePath).catch(() => {});
  }
}

export const planStorage = new PlanStorage();
