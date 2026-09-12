/**
 * KodaX Client
 *
 * 高级模式 - 提供面向对象的 Agent 客户端
 */

import {
  KodaXContextTokenSnapshot,
  KodaXOptions,
  KodaXResult,
  KodaXMessage,
} from './types.js';
import { runKodaX } from './agent.js';

export class KodaXClient {
  private options: KodaXOptions;
  private sessionId: string;
  private messages: KodaXMessage[] = [];
  private contextTokenSnapshot: KodaXContextTokenSnapshot | undefined;

  constructor(options: KodaXOptions, private readonly runAgent: typeof runKodaX = runKodaX) {
    this.options = options;
    this.sessionId = options.session?.id ?? '';
    this.messages = options.session?.initialMessages
      ? [...options.session.initialMessages]
      : [];
    this.contextTokenSnapshot = options.context?.contextTokenSnapshot;
  }

  async send(prompt: string): Promise<KodaXResult> {
    const initialMessages = this.messages.length > 0
      ? this.messages
      : this.options.session?.initialMessages;

    const result = await this.runAgent(
      {
        ...this.options,
        session: {
          ...this.options.session,
          id: this.sessionId || undefined,
          initialMessages,
        },
        context: {
          ...this.options.context,
          contextTokenSnapshot: this.contextTokenSnapshot,
        },
      },
      prompt
    );

    this.sessionId = result.sessionId;
    this.messages = result.messages;
    this.contextTokenSnapshot = result.contextTokenSnapshot;
    return result;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getMessages(): KodaXMessage[] {
    return [...this.messages];
  }

  clear(): void {
    this.messages = [];
    this.sessionId = '';
    this.contextTokenSnapshot = undefined;
  }
}
