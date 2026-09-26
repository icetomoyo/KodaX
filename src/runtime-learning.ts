import { createHash } from 'node:crypto';

import {
  createLearningCenterService,
  createLearnedSkillActionDriver,
  type LearnedCapabilityRecord,
  type LearningEvent,
  type LearningExplicitUserAuthority,
  type LearningPage,
  type LearningQuery,
  type LearningSubscribeOptions,
  type LearningSurfaceSnapshot,
} from '@kodax-ai/agent';

export interface RuntimeLearningSubscription extends AsyncIterableIterator<LearningEvent> {
  /** Registration only; read a snapshot after awaiting ready. */
  readonly ready: Promise<void>;
}

export interface RuntimeLearningService {
  list(query?: LearningQuery): Promise<LearningPage>;
  get(nameOrSlugOrId: string): Promise<LearnedCapabilityRecord>;
  getSnapshot(): Promise<LearningSurfaceSnapshot>;
  events(afterRevision?: number): Promise<readonly LearningEvent[]>;
  subscribe(options?: LearningSubscribeOptions): RuntimeLearningSubscription;
  acknowledge(nameOrSlugOrId: string): Promise<void>;
  snooze(nameOrSlugOrId: string, until: string): Promise<void>;
  reject(nameOrSlugOrId: string): Promise<void>;
  disable(nameOrSlugOrId: string): Promise<void>;
  rollback(nameOrSlugOrId: string): Promise<void>;
  promote(nameOrSlugOrId: string, scope: 'user'): Promise<void>;
  review(nameOrSlugOrId: string): Promise<void>;
  trust(nameOrSlugOrId: string): Promise<void>;
}

interface RuntimeLearningOwner extends RuntimeLearningService {
  forClient(clientIdentity: string): RuntimeLearningService;
}

export interface CreateRuntimeLearningOwnerOptions {
  readonly rootDir: string;
  readonly userSkillsRoot?: string;
  readonly defaultClientIdentity: string;
  readonly proposalStores?: readonly string[];
}

export function createRuntimeLearningOwner(
  options: CreateRuntimeLearningOwnerOptions,
): RuntimeLearningService {
  const actionDrivers = options.userSkillsRoot === undefined
    ? []
    : [createLearnedSkillActionDriver({
        learnedAreaRoot: options.rootDir,
        learnedAreaKind: 'global',
        userSkillsRoot: options.userSkillsRoot,
      })];
  const rootService = createLearningCenterService({
    rootDir: options.rootDir,
    clientIdentity: learningClientFileKey(options.defaultClientIdentity),
    proposalStores: options.proposalStores,
    actionDrivers,
  });
  let ready: Promise<void> | undefined;
  const ensureReady = (): Promise<void> => {
    ready ??= rootService.initialize();
    return ready;
  };
  const forClient = (identity: string): RuntimeLearningService => {
    const key = learningClientFileKey(identity);
    const service = createLearningCenterService({
      rootDir: options.rootDir,
      clientIdentity: key,
      proposalStores: options.proposalStores,
      actionDrivers,
    });
    return createInitializedFacade(service, ensureReady);
  };
  const defaultFacade = createInitializedFacade(rootService, ensureReady);
  return Object.assign(defaultFacade, { forClient }) satisfies RuntimeLearningOwner;
}

export function bindRuntimeLearningClient(
  service: RuntimeLearningService,
  clientIdentity: string,
): RuntimeLearningService {
  const owner = service as Partial<RuntimeLearningOwner>;
  return typeof owner.forClient === 'function' ? owner.forClient(clientIdentity) : service;
}

export function learningClientFileKey(identity: string): string {
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 32);
  return `client_${digest}`;
}

function createInitializedFacade(
  service: ReturnType<typeof createLearningCenterService>,
  sharedReady?: () => Promise<void>,
): RuntimeLearningService {
  let ready: Promise<void> | undefined;
  const ensureReady = (): Promise<void> => {
    ready ??= sharedReady?.() ?? service.initialize();
    return ready;
  };
  return {
    list: async (query) => { await ensureReady(); return service.list(query); },
    get: async (nameOrSlug) => { await ensureReady(); return service.get(nameOrSlug); },
    getSnapshot: async () => { await ensureReady(); return service.getSnapshot(); },
    events: async (afterRevision) => { await ensureReady(); return service.events(afterRevision); },
    subscribe: (options) => subscribeWhenReady(ensureReady(), service, options),
    acknowledge: async (nameOrSlug) => { await ensureReady(); await service.acknowledge(nameOrSlug); },
    snooze: async (nameOrSlug, until) => { await ensureReady(); await service.snooze(nameOrSlug, until); },
    reject: async (nameOrSlug) => {
      await ensureReady();
      await withExplicitUserAuthority(service, nameOrSlug, (authority) => (
        service.reject(nameOrSlug, authority)
      ));
    },
    disable: async (nameOrSlug) => {
      await ensureReady();
      await withExplicitUserAuthority(service, nameOrSlug, (authority) => (
        service.disable(nameOrSlug, authority)
      ));
    },
    rollback: async (nameOrSlug) => {
      await ensureReady();
      await withExplicitUserAuthority(service, nameOrSlug, (authority) => (
        service.rollback(nameOrSlug, authority)
      ));
    },
    promote: async (nameOrSlug, scope) => {
      await ensureReady();
      await withExplicitUserAuthority(service, nameOrSlug, (authority) => (
        service.promote(nameOrSlug, scope, authority)
      ));
    },
    review: async (nameOrSlug) => {
      await ensureReady();
      await withExplicitUserAuthority(service, nameOrSlug, (authority) => (
        service.review(nameOrSlug, authority)
      ));
    },
    trust: async (nameOrSlug) => {
      await ensureReady();
      await withExplicitUserAuthority(service, nameOrSlug, (authority) => (
        service.trust(nameOrSlug, authority)
      ));
    },
  };
}

async function withExplicitUserAuthority(
  service: ReturnType<typeof createLearningCenterService>,
  nameOrSlug: string,
  execute: (authority: LearningExplicitUserAuthority) => Promise<void>,
): Promise<void> {
  const current = await service.get(nameOrSlug);
  await execute({
    authority: 'explicit_user',
    expectedRevision: current.revision,
    ...(current.schemaVersion === 2
      ? { expectedFingerprint: current.artifact.fingerprint }
      : {}),
  });
}

function subscribeWhenReady(
  initialization: Promise<void>,
  service: ReturnType<typeof createLearningCenterService>,
  options: LearningSubscribeOptions | undefined,
): RuntimeLearningSubscription {
  let closed = false;
  let failed = false;
  let failure: unknown;
  let rejectFailure!: (error: unknown) => void;
  const failing = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  void failing.catch(() => undefined); // Retained failure is also delivered to current and future next calls.
  let active: AsyncIterator<LearningEvent> | undefined;
  let closeResult: Promise<IteratorResult<LearningEvent>> | undefined;
  let finishClose!: (result: IteratorResult<LearningEvent>) => void;
  const closing = new Promise<IteratorResult<LearningEvent>>((resolve) => { finishClose = resolve; });
  const opening = initialization.then(() => {
    if (closed) throw new Error('Learning subscription closed before registration completed.');
    active = service.subscribe(options)[Symbol.asyncIterator]();
    return active;
  });
  const ready = Promise.race([opening.then(() => undefined), closing.then(() => {
    throw new Error('Learning subscription closed before registration completed.');
  })]);
  void ready.catch(() => undefined); // The same error is exposed by ready and next.
  return {
    ready,
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (closed) return { done: true, value: undefined };
      if (failed) throw failure;
      try {
        return await Promise.race([opening.then((iterator) => closed
          ? { done: true as const, value: undefined } : iterator.next()), closing, failing]);
      } catch (error: unknown) {
        failed = true;
        failure = error;
        rejectFailure(error);
        throw error;
      }
    },
    return() {
      closed = true;
      finishClose({ done: true, value: undefined });
      // Settle next() waiters immediately; return() waits for initialization and iterator cleanup.
      closeResult ??= initialization.then(() => active?.return?.() ?? { done: true as const, value: undefined });
      return closeResult;
    },
  };
}
