/**
 * Rebalance execution logic.
 * Handles the full rebalance lifecycle: checks, simulation, execution, and logging.
 */

import { getLogger } from '../utils/logger.ts';
import { insertRebalance } from '../utils/db.ts';
import type {
  Position,
  MonitorResult,
  RebalanceAction,
  CLMMAdapter,
  RangeStrategy,
  AppConfig,
} from './types.ts';
import type { CooldownManager } from '../risk/cooldown.ts';
import type { RiskGuards, GuardResult } from '../risk/guards.ts';
import type { GasEstimator } from '../risk/gas-estimator.ts';
import type { PriceFeed } from '../utils/price-feed.ts';
import type { DiscordNotifier } from '../notifications/discord.ts';
import type { CryptactExporter } from '../tax/cryptact-exporter.ts';

/** Tracks when positions went out of range for delayed rebalancing. */
interface OutOfRangeEntry {
  positionId: string;
  detectedAt: Date;
}

/**
 * Rebalance executor that manages the full rebalance lifecycle.
 */
export class Rebalancer {
  private readonly config: AppConfig;
  private readonly cooldown: CooldownManager;
  private readonly guards: RiskGuards;
  private readonly gasEstimator: GasEstimator;
  private readonly priceFeed: PriceFeed;
  private readonly notifier: DiscordNotifier;
  private readonly taxExporter: CryptactExporter;
  private readonly adapters: Map<string, CLMMAdapter>;
  private readonly strategy: RangeStrategy;

  /** Track when positions went out of range. */
  private outOfRangeMap = new Map<string, OutOfRangeEntry>();

  constructor(params: {
    config: AppConfig;
    cooldown: CooldownManager;
    guards: RiskGuards;
    gasEstimator: GasEstimator;
    priceFeed: PriceFeed;
    notifier: DiscordNotifier;
    taxExporter: CryptactExporter;
    adapters: Map<string, CLMMAdapter>;
    strategy: RangeStrategy;
  }) {
    this.config = params.config;
    this.cooldown = params.cooldown;
    this.guards = params.guards;
    this.gasEstimator = params.gasEstimator;
    this.priceFeed = params.priceFeed;
    this.notifier = params.notifier;
    this.taxExporter = params.taxExporter;
    this.adapters = params.adapters;
    this.strategy = params.strategy;
  }

  /**
   * Evaluate monitoring results and execute rebalances where appropriate.
   * @param results Array of monitoring results from the monitor
   * @returns Array of executed rebalance actions
   */
  async evaluateAndRebalance(results: MonitorResult[]): Promise<RebalanceAction[]> {
    const logger = getLogger();
    const executedActions: RebalanceAction[] = [];

    for (const result of results) {
      if (result.status === 'in_range') {
        // Clear out-of-range tracking if position is back in range
        this.outOfRangeMap.delete(result.position.id);
        continue;
      }

      if (result.status === 'out_of_range') {
        try {
          const action = await this.processOutOfRange(result);
          if (action) {
            executedActions.push(action);
          }
        } catch (err) {
          logger.error('Rebalance evaluation failed', {
            positionId: result.position.id,
            error: (err as Error).message,
          });
          await this.notifier.notifyError(
            'Rebalance Failed',
            `Position ${result.position.id}: ${(err as Error).message}`
          );
        }
      }
      // near_boundary: just monitor, don't rebalance yet
    }

    return executedActions;
  }

  /**
   * Process an out-of-range position through the full rebalance pipeline.
   */
  private async processOutOfRange(result: MonitorResult): Promise<RebalanceAction | null> {
    const logger = getLogger();
    const { position, currentPrice, regime } = result;
    const posId = position.id;

    // Step 1: Track when position went out of range
    if (!this.outOfRangeMap.has(posId)) {
      this.outOfRangeMap.set(posId, { positionId: posId, detectedAt: new Date() });
      logger.info('Position went out of range', { positionId: posId, pool: position.pool });
      return null; // First detection, start the wait period
    }

    // Step 2: Check wait time (4-12h after going out of range)
    const entry = this.outOfRangeMap.get(posId)!;
    const elapsedHours = (Date.now() - entry.detectedAt.getTime()) / 3600_000;
    const minWait = this.config.risk.minWaitHoursOutOfRange;
    const maxWait = this.config.risk.maxWaitHoursOutOfRange;

    if (elapsedHours < minWait) {
      logger.debug('Waiting before rebalance', {
        positionId: posId,
        elapsedHours: elapsedHours.toFixed(1),
        minWait,
      });
      return null;
    }

    // Step 3: Check cooldown
    const cooldownCheck = this.cooldown.canRebalance(posId);
    if (!cooldownCheck.allowed) {
      logger.info('Cooldown active', { positionId: posId, reason: cooldownCheck.reason });
      return null;
    }

    // Step 4: Estimate costs
    const gasEstimate = this.gasEstimator.estimateRebalanceCost(position.chain);
    const estimatedCost = gasEstimate.totalUsd;

    // Step 5: Cost check — skip if cost > 50% of expected fee income
    const expectedFeeIncome = this.estimateExpectedFeeIncome(position);
    if (!this.gasEstimator.isCostJustified(estimatedCost, expectedFeeIncome, this.config.risk.costToFeeThreshold)) {
      logger.info('Rebalance not cost-justified', {
        positionId: posId,
        estimatedCost,
        expectedFeeIncome,
      });
      // After max wait, force rebalance regardless of cost
      if (elapsedHours < maxWait) {
        return null;
      }
      logger.warn('Max wait exceeded, forcing rebalance despite cost', { positionId: posId });
    }

    // Step 6: Oracle deviation check
    let oraclePrice: number;
    try {
      const tokenSymbol = this.extractTokenSymbol(position.tokenA);
      const priceData = await this.priceFeed.getPrice(tokenSymbol);
      oraclePrice = priceData.price;
    } catch {
      logger.warn('Oracle price unavailable, using DEX price', { positionId: posId });
      oraclePrice = currentPrice;
    }

    // Step 7: Run all guard checks
    const prices = [currentPrice]; // Simplified; in production use full history
    const guardResult = this.guards.runAllChecks({
      priceChange24hPct: 0, // Would need 24h price data
      estimatedSlippageBps: 30, // Estimated; would come from swap quote
      todayRebalanceCount: 0, // Would come from DB
      oraclePrice,
      dexPrice: currentPrice,
      prices,
    });

    if (!guardResult.allowed) {
      logger.warn('Guard check blocked rebalance', {
        positionId: posId,
        reason: guardResult.reason,
      });
      if (guardResult.severity === 'critical') {
        await this.notifier.notifyCircuitBreaker(guardResult.reason, guardResult.severity);
      }
      return null;
    }

    // Step 8: Calculate new range
    const priceHistory = prices; // Would use full history from monitor
    const newRange = this.strategy.calculateRange({
      currentPrice,
      prices: priceHistory,
      regime,
    });

    // Step 9: Simulate transaction
    const adapter = this.getAdapter(position);
    const simulation = await adapter.simulateRebalance({
      positionId: posId,
      newLowerPrice: newRange.lower,
      newUpperPrice: newRange.upper,
    });

    if (!simulation.success) {
      logger.error('Rebalance simulation failed', {
        positionId: posId,
        error: simulation.error,
      });
      return null;
    }

    // Step 10: Execute rebalance
    const action = await this.executeRebalance(position, adapter, newRange, estimatedCost);

    // Clear the out-of-range tracking
    this.outOfRangeMap.delete(posId);

    return action;
  }

  /**
   * Execute the full rebalance: collect fees -> close position -> swap -> open new position.
   */
  private async executeRebalance(
    position: Position,
    adapter: CLMMAdapter,
    newRange: { lower: number; upper: number },
    estimatedCost: number
  ): Promise<RebalanceAction> {
    const logger = getLogger();
    const posId = position.id;

    logger.info('Executing rebalance', {
      positionId: posId,
      oldRange: [position.lowerPrice, position.upperPrice],
      newRange: [newRange.lower, newRange.upper],
    });

    const action: RebalanceAction = {
      positionId: posId,
      reason: 'Position out of range',
      oldRange: [position.lowerPrice, position.upperPrice],
      newRange: [newRange.lower, newRange.upper],
      estimatedCost,
      timestamp: new Date(),
    };

    try {
      // 1. Collect fees
      const fees = await adapter.collectFees(posId);
      logger.info('Fees collected', {
        positionId: posId,
        tokenA: fees.tokenAAmount.toString(),
        tokenB: fees.tokenBAmount.toString(),
      });

      // 2. Close position
      const withdrawn = await adapter.closePosition(posId);
      logger.info('Position closed', {
        positionId: posId,
        tokenA: withdrawn.tokenAAmount.toString(),
        tokenB: withdrawn.tokenBAmount.toString(),
      });

      // 3. Open new position with new range
      const totalTokenA = withdrawn.tokenAAmount + fees.tokenAAmount;
      const totalTokenB = withdrawn.tokenBAmount + fees.tokenBAmount;

      const newPosition = await adapter.openPosition({
        pool: position.pool,
        lowerPrice: newRange.lower,
        upperPrice: newRange.upper,
        tokenAAmount: totalTokenA,
        tokenBAmount: totalTokenB,
      });

      logger.info('New position opened', {
        positionId: newPosition.id,
        pool: newPosition.pool,
        range: [newRange.lower, newRange.upper],
      });

      // 4. Record in database
      try {
        insertRebalance({
          position_id: posId,
          reason: action.reason,
          old_lower: action.oldRange[0],
          old_upper: action.oldRange[1],
          new_lower: action.newRange[0],
          new_upper: action.newRange[1],
          estimated_cost: estimatedCost,
          timestamp: action.timestamp.toISOString(),
        });
      } catch (dbErr) {
        logger.error('Failed to log rebalance to DB', { error: (dbErr as Error).message });
      }

      // 5. Record cooldown
      this.cooldown.recordRebalance(posId);

      // 6. Send notification
      await this.notifier.notifyRebalance(action, true);

      return action;
    } catch (err) {
      logger.error('Rebalance execution failed', {
        positionId: posId,
        error: (err as Error).message,
      });
      await this.notifier.notifyRebalance(action, false);
      throw err;
    }
  }

  /**
   * Estimate expected fee income for a position until the next rebalance.
   * Uses historical fee rate as a rough estimate.
   */
  private estimateExpectedFeeIncome(position: Position): number {
    const ageHours = (Date.now() - position.openedAt.getTime()) / 3600_000;
    if (ageHours <= 0) return 0;

    // Fee rate per hour based on historical data
    const feeRatePerHour = position.feesEarnedUsd / ageHours;
    // Assume fees for the next cooldown period
    return feeRatePerHour * this.config.risk.cooldownHours;
  }

  /**
   * Extract a token symbol from a token address or identifier.
   * Simple heuristic: if it looks like a known symbol, use it.
   */
  private extractTokenSymbol(token: string): string {
    const upper = token.toUpperCase();
    if (upper.includes('SOL')) return 'SOL';
    if (upper.includes('SUI')) return 'SUI';
    if (upper.includes('MSOL')) return 'mSOL';
    if (upper.includes('USDC')) return 'USDC';
    return 'SOL'; // Default
  }

  /**
   * Get the appropriate adapter for a position.
   */
  private getAdapter(position: Position): CLMMAdapter {
    const key = `${position.chain}-${position.dex}`;
    const adapter = this.adapters.get(key);
    if (!adapter) {
      throw new Error(`No adapter found for ${key}`);
    }
    return adapter;
  }
}
