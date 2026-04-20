/**
 * Shared type declarations for the command-argument completer subsystem.
 *
 * FEATURE_093 (v0.7.24): extracted from `argument-completer.ts` to break
 * the `argument-completer.ts ↔ command-arguments.ts` cycle. Both modules
 * now import these types from this file.
 */

/** Argument definition for autocomplete. */
export interface ArgumentDefinition {
  /** Argument name/value. */
  name: string;
  /** Description for display. */
  description: string;
  /** Argument type. */
  type?: 'string' | 'number' | 'boolean' | 'enum';
  /** Whether this argument is required. */
  required?: boolean;
}

/** Command arguments registry type. */
export type CommandArgumentsRegistry = Map<string, ArgumentDefinition[]>;
