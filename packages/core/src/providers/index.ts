/**
 * KodaX Providers
 *
 * Provider 模块统一导出 - 从 @kodax/ai 重新导出
 * @deprecated 直接从 @kodax/ai 导入
 */

// Re-export everything from @kodax/ai for backward compatibility
export {
  KodaXBaseProvider,
  KodaXAnthropicCompatProvider,
  KodaXOpenAICompatProvider,
  KODAX_PROVIDERS,
  KODAX_DEFAULT_PROVIDER,
  getProvider,
  isProviderConfigured,
  getProviderModel,
  getProviderList,
  isProviderName,
} from '@kodax/ai';
export type { ProviderName } from '@kodax/ai';
