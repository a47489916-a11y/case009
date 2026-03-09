/**
 * Main orchestration engine for the CLMM Manager Bot.
 * Initializes all components, runs the monitoring loop, and handles lifecycle.
 */

import { getLogger, initLogger } from '../utils/logger.ts';
import { initDatabase, closeDatabase, upsertDailySnapshot, getTodayRebalanceCount } from '../utils/db.ts';
import { PriceFeed } from '../utils/price-feed.ts';
import { PositionMonitor } from './monitor.ts';
import { Rebalancer } from './rebalancer.ts';
import { RiskGuards } from '../risk/guards.ts';
import { CooldownManager } from '../risk/cooldown.ts';
import { GasEstimator } from '../risk/gas-estimator.ts';
import { ILTracker } from '../risk/il-tracker.ts';
import { DiscordNotifier } from '../notifications/discord.ts';
import { CryptactExporter } from '../tax/cryptact-exporter.ts';
import { OrcaAdapter } from '../chains/solana/orca-adapter.ts';
import { RaydiumAdapter } from '../chains/solana/raydium-adapter.ts';
import { CetusAdapter } from '../chains/sui/cetus-adapter.ts';
import { Volatility2SigmaStrategy } from '../strategy/volatility.ts';
import { FixedPctStrategy } from '../strategy/fixed-pct.ts';
import { BollingerStrategy } from '../strategy/bollinger.ts';
import { CapitalAllocator } from '../strategy/allocator.ts';
import type { AppConfig, CLMMAdapter, RangeStrategy, DailySummary } from './types.ts';

/** Maximum consecutive errors before applying extended backoff. */
const MAX_CONSECUTIVE_ERRORS = 5;

/** Base delay for exponential backoff (ms). */
const BASE_BACKOFF_MS = 5000;

/**
 * Main engine that orchestrates all CLMM management operations.
 */
export class Engine {
  private readonly config: AppConfig;
  private monitor!: PositionMonitor;
  private rebalancer!: Rebalancer;
  private ilTracker!: ILTracker;
  private allocator!: CapitalAllocator;
  private priceFeed!: PriceFeed;
  private notifier!: DiscordNotifier;
  private gasEstimator!: GasEstimator;
  private adapters = new Map<string, CLMMAdapter>();

  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private dailySummaryInterval: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private consecutiveErrors = 0;
  private cycleCount = 0;

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Initialize all components and prepare the engine for operation.
   */
  async initialize(): Promise<void> {
    const logger = initLogger(this.config.logging.level, this.config.logging.dir);
    logger.info('Initializing CLMM Manager Engine');

    // Initialize database
    initDatabase(this.config.database.path);

    // Initialize price feed
    this.priceFeed = new PriceFeed({
      pythEndpoint: this.config.priceFeed.pythEndpoint,
      coingeckoApiKey: this.config.priceFeed.coingeckoApiKey,
      cacheTtlMs: this.config.priceFeed.cacheTtlMs,
    });

    // Initialize Discord notifier
    this.notifier = new DiscordNotifier(this.config.notifications.discordWebhookUrl);

    // Initialize gas estimator
    this.gasEstimator = new GasEstimator();

    // Update gas estimator with current prices
    try {
      const prices = await this.priceFeed.getPrices(['SOL', 'SUI']);
      const solPrice = prices.get('SOL')?.price ?? 0;
      const suiPrice = prices.get('SUI')?.price ?? 0;
      this.gasEstimator.updatePrices(solPrice, suiPrice);
    } catch (err) {
      logger.warn('Failed to fetch initial prices for gas estimation', {
        error: (err as Error).message,
      });
    }

    // Initialize chain adapters
    this.initializeAdapters();

    // Initialize strategy
    const strategy = this.createStrategy();

    // Initialize risk components
    const guards = new RiskGuards(this.config.risk);
    const cooldown = new CooldownManager({
      cooldownHours: this.config.risk.cooldownHours,
      maxRebalancesPerDay: this.config.risk.maxRebalancesPerDay,
    });

    // Initialize tax exporter
    const taxExporter = new CryptactExporter({
      outputDir: this.config.tax.outputDir,
      baseCurrency: this.config.tax.baseCurrency,
    });

    // Initialize IL tracker
    this.ilTracker = new ILTracker();

    // Initialize allocator
    this.allocator = new CapitalAllocator({
      pools: this.config.allocation.pools,
      usdcReservePct: this.config.allocation.usdcReservePct,
    });

    // Initialize monitor
    this.monitor = new PositionMonitor({
      config: this.config,
      priceFeed: this.priceFeed,
      notifier: this.notifier,
      adapters: this.adapters,
    });

    // Initialize rebalancer
    this.rebalancer = new Rebalancer({
      config: this.config,
      cooldown,
      guards,
      gasEstimator: this.gasEstimator,
      priceFeed: this.priceFeed,
      notifier: this.notifier,
      taxExporter,
      adapters: this.adapters,
      strategy,
    });

    logger.info('CLMM Manager Engine initialized', {
      strategy: this.config.strategy.type,
      pools: this.config.allocation.pools.length,
      monitorInterval: this.config.monitoring.intervalMs,
    });
  }

  /**
   * Start the monitoring loop and daily summary scheduler.
   */
  start(): void {
    const logger = getLogger();

    if (this.isRunning) {
      logger.warn('Engine is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting CLMM Manager monitoring loop', {
      intervalMs: this.config.monitoring.intervalMs,
    });

    // Run first cycle immediately
    void this.runCycle();

    // Start monitoring interval
    this.monitorInterval = setInterval(() => {
      void this.runCycle();
    }, this.config.monitoring.intervalMs);

    // Schedule daily summary at midnight UTC
    this.scheduleDailySummary();

    logger.info('CLMM Manager is now running');
  }

  /**
   * Stop the engine gracefully.
   */
  async stop(): Promise<void> {
    const logger = getLogger();
    logger.info('Stopping CLMM Manager Engine...');

    this.isRunning = false;

    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    if (this.dailySummaryInterval) {
      clearInterval(this.dailySummaryInterval);
      this.dailySummaryInterval = null;
    }

    // Generate final daily summary
    try {
      await this.generateDailySummary();
    } catch (err) {
      logger.error('Failed to generate final daily summary', { error: (err as Error).message });
    }

    closeDatabase();
    logger.info('CLMM Manager Engine stopped');
  }

  /**
   * Run a single monitoring + rebalance cycle.
   */
  private async runCycle(): Promise<void> {
    const logger = getLogger();
    this.cycleCount++;

    try {
      // Step 1: Monitor all positions
      const results = await this.monitor.checkAll();

      logger.debug('Monitoring cycle complete', {
        cycle: this.cycleCount,
        positions: results.length,
        inRange: results.filter((r) => r.status === 'in_range').length,
        nearBoundary: results.filter((r) => r.status === 'near_boundary').length,
        outOfRange: results.filter((r) => r.status === 'out_of_range').length,
      });

      // Step 2: Evaluate and execute rebalances
      if (results.some((r) => r.status === 'out_of_range')) {
        const actions = await this.rebalancer.evaluateAndRebalance(results);

        if (actions.length > 0) {
          logger.info('Rebalances executed', { count: actions.length });
        }
      }

      // Step 3: Update gas estimator prices periodically (every ~5 minutes)
      if (this.cycleCount % 10 === 0) {
        await this.updateGasPrices();
      }

      // Reset error counter on successful cycle
      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      logger.error('Monitoring cycle failed', {
        cycle: this.cycleCount,
        consecutiveErrors: this.consecutiveErrors,
        error: (err as Error).message,
      });

      // Exponential backoff on repeated failures
      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        const backoffMs = Math.min(
          BASE_BACKOFF_MS * Math.pow(2, this.consecutiveErrors - MAX_CONSECUTIVE_ERRORS),
          300_000 // Max 5 minutes
        );
        logger.warn(`Applying backoff: ${backoffMs}ms after ${this.consecutiveErrors} consecutive errors`);

        await this.notifier.notifyError(
          'Repeated Failures',
          `${this.consecutiveErrors} consecutive monitoring cycle failures. Applying ${backoffMs}ms backoff.`
        );

        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  /**
   * Update gas estimator with fresh token prices.
   */
  private async updateGasPrices(): Promise<void> {
    try {
      const prices = await this.priceFeed.getPrices(['SOL', 'SUI']);
      const solPrice = prices.get('SOL')?.price ?? 0;
      const suiPrice = prices.get('SUI')?.price ?? 0;
      this.gasEstimator.updatePrices(solPrice, suiPrice);
    } catch {
      // Non-critical; gas estimates will use stale prices
    }
  }

  /**
   * Initialize all chain adapters based on config.
   */
  private initializeAdapters(): void {
    // Solana adapters
    this.adapters.set(
      'solana-orca',
      new OrcaAdapter({
        rpcUrl: this.config.solana.rpcUrl,
        walletPath: this.config.solana.walletPath,
      })
    );

    this.adapters.set(
      'solana-raydium',
      new RaydiumAdapter({
        rpcUrl: this.config.solana.rpcUrl,
        walletPath: this.config.solana.walletPath,
      })
    );

    // SUI adapters
    this.adapters.set(
      'sui-cetus',
      new CetusAdapter({
        rpcUrl: this.config.sui.rpcUrl,
        walletPath: this.config.sui.walletPath,
      })
    );
  }

  /**
   * Create the strategy instance based on config.
   */
  private createStrategy(): RangeStrategy {
    const { type, params } = this.config.strategy;

    switch (type) {
      case 'volatility_2sigma':
        return new Volatility2SigmaStrategy(params);
      case 'fixed_pct':
        return new FixedPctStrategy(params);
      case 'bollinger':
        return new BollingerStrategy(params);
      default:
        throw new Error(`Unknown strategy type: ${type}`);
    }
  }

  /**
   * Schedule daily summary generation at midnight UTC.
   */
  private scheduleDailySummary(): void {
    // Calculate ms until next midnight UTC
    const now = new Date();
    const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const msUntilMidnight = nextMidnight.getTime() - now.getTime();

    // First run at midnight, then every 24h
    setTimeout(() => {
      void this.generateDailySummary();
      this.dailySummaryInterval = setInterval(() => {
        void this.generateDailySummary();
      }, 24 * 3600_000);
    }, msUntilMidnight);
  }

  /**
   * Generate and send the daily summary report.
   */
  private async generateDailySummary(): Promise<void> {
    const logger = getLogger();
    logger.info('Generating daily summary');

    try {
      const results = await this.monitor.checkAll();
      let rebalanceCount: number;
      try {
        rebalanceCount = getTodayRebalanceCount();
      } catch {
        rebalanceCount = 0;
      }

      const totalIl = this.ilTracker.getCumulativeIL();

      const summary: DailySummary = {
        date: new Date().toISOString().slice(0, 10),
        totalValueUsd: results.reduce((sum, r) => sum + r.position.currentValueUsd, 0),
        totalFeesUsd: results.reduce((sum, r) => sum + r.position.feesEarnedUsd, 0),
        totalIlUsd: totalIl,
        rebalanceCount,
        positions: results.map((r) => ({
          id: r.position.id,
          pool: r.position.pool,
          status: r.status,
          valueUsd: r.position.currentValueUsd,
          feesUsd: r.position.feesEarnedUsd,
          ilPct: 0, // Would need entry price to compute
        })),
      };

      // Store in database
      try {
        upsertDailySnapshot({
          date: summary.date,
          total_value_usd: summary.totalValueUsd,
          total_fees_usd: summary.totalFeesUsd,
          total_il_usd: summary.totalIlUsd,
          rebalance_count: summary.rebalanceCount,
          positions_json: JSON.stringify(summary.positions),
        });
      } catch (dbErr) {
        logger.error('Failed to store daily snapshot', { error: (dbErr as Error).message });
      }

      // Send Discord notification
      await this.notifier.notifyDailySummary(summary);

      logger.info('Daily summary generated', {
        totalValue: summary.totalValueUsd,
        totalFees: summary.totalFeesUsd,
        rebalances: summary.rebalanceCount,
      });
    } catch (err) {
      logger.error('Failed to generate daily summary', { error: (err as Error).message });
    }
  }
}
