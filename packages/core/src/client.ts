/**
 * KodaX Client
 *
 * 高级模式 - 提供面向对象的 Agent 客户端
 */

import { KodaXOptions, KodaXResult, KodaXMessage } from './types.js';
import { runKodaX } from './agent.js';

export class KodaXClient {
  private options: KodaXOptions;
  private sessionId: string;
  private messages: KodaXMessage[] = [];

  constructor(options: KodaXOptions) {
    this.options = options;
    this.sessionId = options.session?.id ?? '';
  }

  async send(prompt: string): Promise<KodaXResult> {
    const result = await runKodaX(
      {
        ...this.options,
        session: {
          ...this.options.session,
          id: this.sessionId || undefined,
        },
      },
      prompt
    );

    this.sessionId = result.sessionId;
    this.messages = result.messages;
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
  }
}
