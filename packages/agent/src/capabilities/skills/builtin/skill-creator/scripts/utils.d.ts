export declare function setKodaXSDKForSkillCreator(
  sdk: Readonly<Record<string, unknown>> | null,
): void;
export declare function getDefaultSkillsDir(): string;
/** One tool-free provider request; `effort` wins over a legacy `reasoningMode`. */
export declare function completeOnce(
  prompt: string,
  options: { provider?: string; model?: string; effort?: string; reasoningMode?: string },
): Promise<string>;
