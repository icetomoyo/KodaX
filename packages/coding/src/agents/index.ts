

export {
  CODING_AGENT_MARKER,
} from './coding-agents.js';

// FEATURE_193 v0.7.43: V1 chain (Scout/Planner/Generator) Agent declarations
// retired. The string name constants preserve historical session ids;
// Worker is the only Agent declared.
export {
  SCOUT_AGENT_NAME,
  PLANNER_AGENT_NAME,
  GENERATOR_AGENT_NAME,
  WORKER_AGENT_NAME,
  TASK_ENGINE_ROLE_AGENTS,
  workerAgent,
} from './task-engine-agents.js';
