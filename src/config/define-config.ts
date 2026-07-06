import type { FlakehoundUserConfig } from './schema.js';

/** Typed identity helper for flakehound.config.ts — gives autocomplete and type-checking. */
export function defineConfig(config: FlakehoundUserConfig): FlakehoundUserConfig {
  return config;
}
