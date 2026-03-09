/**
 * Configuration loader with zod validation.
 * Loads from config/default.yaml and overrides with environment variables.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import dotenv from 'dotenv';
import type { AppConfig } from './core/types.ts';

dotenv.config();

/** Zod schema for full application configuration. */
const appConfigSchema = z.object({
  solana: z.object({
    rpcUrl: z.string().url(),
    walletPath: z.string().min(1),
  }),
  sui: z.object({
    rpcUrl: z.string().url(),
    walletPath: z.string().min(1),
  }),
  strategy: z.object({
    type: z.enum(['volatility_2sigma', 'fixed_pct', 'bollinger']),
    params: z.record(z.string(), z.number()),
  }),
  risk: z.object({
    maxRebalancesPerDay: z.number().int().min(1).max(50),
    cooldownHours: z.number().min(0),
    circuitBreaker24hPct: z.number().min(1).max(100),
    maxSlippageBps: z.number().int().min(1).max(1000),
    oracleDeviationPct: z.number().min(0.1).max(10),
    minWaitHoursOutOfRange: z.number().min(0),
    maxWaitHoursOutOfRange: z.number().min(0),
    costToFeeThreshold: z.number().min(0).max(1),
  }),
  allocation: z.object({
    pools: z.array(
      z.object({
        pool: z.string(),
        chain: z.string(),
        dex: z.string(),
        weight: z.number().min(0).max(1),
      })
    ),
    usdcReservePct: z.number().min(0).max(1),
  }),
  notifications: z.object({
    discordWebhookUrl: z.string(),
  }),
  tax: z.object({
    outputDir: z.string(),
    baseCurrency: z.string(),
  }),
  monitoring: z.object({
    intervalMs: z.number().int().min(1000),
    nearBoundaryPct: z.number().min(0.01).max(0.5),
  }),
  database: z.object({
    path: z.string(),
  }),
  logging: z.object({
    level: z.string(),
    dir: z.string(),
  }),
  priceFeed: z.object({
    pythEndpoint: z.string().url(),
    coingeckoApiKey: z.string(),
    cacheTtlMs: z.number().int().min(1000),
  }),
});

/**
 * Apply environment variable overrides on top of the YAML config.
 * Env vars take precedence over YAML values.
 */
function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const env = process.env;

  const solana = (config.solana ?? {}) as Record<string, unknown>;
  const sui = (config.sui ?? {}) as Record<string, unknown>;
  const strategy = (config.strategy ?? {}) as Record<string, unknown>;
  const risk = (config.risk ?? {}) as Record<string, unknown>;
  const notifications = (config.notifications ?? {}) as Record<string, unknown>;
  const tax = (config.tax ?? {}) as Record<string, unknown>;
  const database = (config.database ?? {}) as Record<string, unknown>;
  const logging = (config.logging ?? {}) as Record<string, unknown>;
  const priceFeed = (config.priceFeed ?? {}) as Record<string, unknown>;

  if (env.SOLANA_RPC_URL) solana.rpcUrl = env.SOLANA_RPC_URL;
  if (env.SOLANA_WALLET_PATH) solana.walletPath = env.SOLANA_WALLET_PATH;
  if (env.SUI_RPC_URL) sui.rpcUrl = env.SUI_RPC_URL;
  if (env.SUI_WALLET_PATH) sui.walletPath = env.SUI_WALLET_PATH;

  if (env.STRATEGY_TYPE) strategy.type = env.STRATEGY_TYPE;
  if (env.STRATEGY_PARAMS) {
    try {
      strategy.params = JSON.parse(env.STRATEGY_PARAMS);
    } catch {
      // Ignore invalid JSON; keep YAML params
    }
  }

  if (env.MAX_REBALANCES_PER_DAY) risk.maxRebalancesPerDay = Number(env.MAX_REBALANCES_PER_DAY);
  if (env.COOLDOWN_HOURS) risk.cooldownHours = Number(env.COOLDOWN_HOURS);
  if (env.CIRCUIT_BREAKER_24H_PCT) risk.circuitBreaker24hPct = Number(env.CIRCUIT_BREAKER_24H_PCT);
  if (env.MAX_SLIPPAGE_BPS) risk.maxSlippageBps = Number(env.MAX_SLIPPAGE_BPS);
  if (env.ORACLE_DEVIATION_PCT) risk.oracleDeviationPct = Number(env.ORACLE_DEVIATION_PCT);

  if (env.DISCORD_WEBHOOK_URL) notifications.discordWebhookUrl = env.DISCORD_WEBHOOK_URL;

  if (env.TAX_OUTPUT_DIR) tax.outputDir = env.TAX_OUTPUT_DIR;
  if (env.TAX_BASE_CURRENCY) tax.baseCurrency = env.TAX_BASE_CURRENCY;

  if (env.DB_PATH) database.path = env.DB_PATH;

  if (env.LOG_LEVEL) logging.level = env.LOG_LEVEL;
  if (env.LOG_DIR) logging.dir = env.LOG_DIR;

  if (env.PYTH_ENDPOINT) priceFeed.pythEndpoint = env.PYTH_ENDPOINT;
  if (env.COINGECKO_API_KEY) priceFeed.coingeckoApiKey = env.COINGECKO_API_KEY;

  return {
    ...config,
    solana,
    sui,
    strategy,
    risk,
    notifications,
    tax,
    database,
    logging,
    priceFeed,
  };
}

/**
 * Load, merge, and validate the application configuration.
 * @param configPath Optional path to the YAML config file. Defaults to config/default.yaml.
 */
export function loadConfig(configPath?: string): AppConfig {
  const resolvedPath = configPath ?? resolve(process.cwd(), 'config', 'default.yaml');

  let yamlContent: Record<string, unknown> = {};
  try {
    const raw = readFileSync(resolvedPath, 'utf-8');
    yamlContent = parseYaml(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to read config file at ${resolvedPath}: ${(err as Error).message}`);
  }

  const merged = applyEnvOverrides(yamlContent);

  const result = appConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${issues}`);
  }

  return result.data as AppConfig;
}
