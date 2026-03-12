/**
 * KodaX Provider Registry
 *
 * Provider 注册表 - 统一管理所有 Provider
 */
import { KodaXBaseProvider } from './base.js';
export type ProviderName = 'anthropic' | 'openai' | 'kimi' | 'kimi-code' | 'qwen' | 'zhipu' | 'zhipu-coding' | 'minimax-coding' | 'gemini-cli' | 'codex-cli';
export declare const KODAX_PROVIDERS: Record<string, () => KodaXBaseProvider>;
export declare const KODAX_DEFAULT_PROVIDER: string;
export declare function getProvider(name?: string): KodaXBaseProvider;
export declare function isProviderConfigured(name: string): boolean;
export declare function getProviderModel(name: string): string | null;
export declare function getProviderList(): Array<{
    name: string;
    model: string;
    configured: boolean;
}>;
export declare function isProviderName(name: string): name is ProviderName;
//# sourceMappingURL=registry.d.ts.map