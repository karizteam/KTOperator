import { z } from 'zod';

/** Versioned, schema-validated configuration. Bump + migrate on change. */
export const CONFIG_VERSION = 1;

export const providerTypeSchema = z.enum([
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'openai-compatible',
  'ollama',
]);
export type ProviderType = z.infer<typeof providerTypeSchema>;

export const providerProfileSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, { error: 'Provider IDs may contain letters, numbers, dot, dash, underscore.' }),
  type: providerTypeSchema,
  /** Custom endpoint. Validated against SSRF rules before any request. */
  baseUrl: z.string().max(500).optional(),
  /** Default model id for this profile. */
  model: z.string().max(200).optional(),
  /** Env var that holds the API key (defaults per provider type). */
  apiKeyEnv: z.string().max(100).optional(),
  /** OpenRouter attribution headers (optional). */
  referer: z.string().max(300).optional(),
  title: z.string().max(200).optional(),
  /** Explicitly trust a loopback/private endpoint (local inference only). */
  trustedLocal: z.boolean().default(false),
  /** Override detected capabilities when a deployment lies about them. */
  capabilityOverrides: z
    .object({
      streaming: z.boolean().optional(),
      toolCalling: z.boolean().optional(),
      structuredOutputs: z.boolean().optional(),
    })
    .optional(),
});
export type ProviderProfile = z.infer<typeof providerProfileSchema>;

const workspaceRefSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  selectedAt: z.string().min(1),
});

export const configSchema = z.object({
  version: z.literal(CONFIG_VERSION),
  defaultProvider: z.string().optional(),
  defaultModel: z.string().optional(),
  providers: z.array(providerProfileSchema).default([]),
  /**
   * Fallback chain: when the active provider rate-limits, runs out of credits
   * or cannot be reached, continue the run on another configured profile
   * instead of destroying the session. Off by default — silently answering
   * with a different model is not something to opt someone into.
   */
  fallback: z
    .object({
      enabled: z.boolean().default(false),
      /** Profile ids, in order. Empty = every other profile, in config order. */
      order: z.array(z.string().min(1).max(64)).max(10).default([]),
    })
    .default({ enabled: false, order: [] }),
  workspace: z
    .object({
      current: workspaceRefSchema.optional(),
      recent: z.array(workspaceRefSchema).default([]),
    })
    .default({ recent: [] }),
  security: z
    .object({
      /** Opt-in escape hatch: run sandboxed commands without containers. */
      allowRestrictedProcessFallback: z.boolean().default(false),
      /** Highest tier `--yes` may auto-approve. Tier 3 never auto-approves here. */
      maxAutoApproveTier: z.number().int().min(0).max(2).default(1),
    })
    .default({ allowRestrictedProcessFallback: false, maxAutoApproveTier: 1 }),
  sandbox: z
    .object({
      backend: z.enum(['auto', 'docker', 'restricted']).default('auto'),
      image: z.string().default('node:22-alpine'),
      network: z.boolean().default(false),
      memoryMb: z.number().int().min(64).max(65536).default(512),
      cpus: z.number().min(0.25).max(32).default(1),
      pidsLimit: z.number().int().min(16).max(4096).default(128),
      writableDefault: z.boolean().default(false),
    })
    .default({ backend: 'auto', image: 'node:22-alpine', network: false, memoryMb: 512, cpus: 1, pidsLimit: 128, writableDefault: false }),
  network: z
    .object({
      /** Allow provider base URLs that resolve to private/loopback addresses. */
      allowPrivateProviderEndpoints: z.boolean().default(false),
    })
    .default({ allowPrivateProviderEndpoints: false }),
  limits: z
    .object({
      maxIterations: z.number().int().min(1).max(100).default(12),
      maxToolCalls: z.number().int().min(1).max(500).default(30),
      maxDurationMs: z.number().int().min(10_000).max(3_600_000).default(600_000),
      maxOutputBytes: z.number().int().min(1024).max(4_000_000).default(64 * 1024),
      maxFileBytes: z.number().int().min(1024).max(512 * 1024 * 1024).default(2 * 1024 * 1024),
      maxProcesses: z.number().int().min(1).max(64).default(8),
      maxProviderRetries: z.number().int().min(0).max(10).default(3),
      maxTokens: z.number().int().min(256).max(200_000).optional(),
    })
    .default({
      maxIterations: 12,
      maxToolCalls: 30,
      maxDurationMs: 600_000,
      maxOutputBytes: 64 * 1024,
      maxFileBytes: 2 * 1024 * 1024,
      maxProcesses: 8,
      maxProviderRetries: 3,
    }),
  backups: z
    .object({
      enabled: z.boolean().default(true),
      maxMb: z.number().int().min(1).max(50_000).default(256),
    })
    .default({ enabled: true, maxMb: 256 }),
  ui: z.object({ color: z.boolean().default(true) }).default({ color: true }),
});

export type OperatorConfig = z.infer<typeof configSchema>;

export function defaultConfig(): OperatorConfig {
  return configSchema.parse({ version: CONFIG_VERSION });
}
