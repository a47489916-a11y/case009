/**
 * Position monitoring module.
 * Runs on a 30-second interval to check position health and trigger notifications.
 */

import { getLogger } from '../utils/logger.ts';
import { distanceToBoundary } from '../utils/math.ts';
import { detectMarketRegime } from '../strategy/volatility.ts';
import type {
  Position,
  PositionStatus,
  MonitorResult,
  CLMMAdapter,
  AppConfig,
  MarketRegime,
} from './types.ts';
import type { PriceFeed } from '../utils/price-feed.ts';
import type { DiscordNotifier } from '../notifications/discord.ts';

/**
 * Position monitor that periodically checks all positions.
 */
export class PositionMonitor {
  private readonly config: AppConfig;
  private readonly priceFeed: PriceFeed;
  private readonly notifier: DiscordNotifier;
  private readonly adapters: Map<string, CLMMAdapter>;

  /** Track previous status per position to detect changes. */
  private previousStatuses = new Map<string, PositionStatus>();

  /** Historical prices per pool for regime detection. */
  private priceHistories = new Map<string, number[]>();

  /** Maximum price history entries to keep per pool. */
  private readonly maxHistoryLength = 500;

  constructor(params: {
    config: AppConfig;
    priceFeed: PriceFeed;
    notifier: DiscordNotifier;
    adapters: Map<string, CLMMAdapter>;
  }) {
    this.config = params.config;
    this.priceFeed = params.priceFeed;
    this.notifier = params.notifier;
    this.adapters = params.adapters;
  }

  /**
   * Run a single monitoring cycle across all positions.
   * @returns Array of monitoring results for each position
   */
  async checkAll(): Promise<MonitorResult[]> {
    const logger = getLogger();
    const results: MonitorResult[] = [];

    for (const [key, adapter] of this.adapters) {
      try {
        const positions = await adapter.getPositions();

        for (const position of positions) {
          try {
            const result = await this.checkPosition(position, adapter);
            results.push(result);

            // Notify on status changes
            const prevStatus = this.previousStatuses.get(position.id);
            if (prevStatus && prevStatus !== result.status) {
              logger.info('Position status changed', {
                positionId: position.id,
                pool: position.pool,
                from: prevStatus,
                to: result.status,
              });
              await this.notifier.notifyPositionStatus(position, result.status, result.currentPrice);
            }

            this.previousStatuses.set(position.id, result.status);
          } catch (err) {
            logger.error('Failed to check position', {
              positionId: position.id,
              error: (err as Error).message,
            });
          }
        }
      } catch (err) {
        logger.error('Failed to fetch positions from adapter', {
          adapter: key,
          error: (err as Error).message,
        });
      }
    }

    return results;
  }

  /**
   * Check a single position against the current market price.
   */
  private async checkPosition(position: Position, adapter: CLMMAdapter): Promise<MonitorResult> {
    const currentPrice = await adapter.getPoolPrice(position.pool);

    // Update price history
    this.recordPrice(position.pool, currentPrice);
    const priceHistory = this.priceHistories.get(position.pool) ?? [currentPrice];

    // Determine position status
    const status = this.determineStatus(currentPrice, position);

    // Detect market regime
    const regime = detectMarketRegime(priceHistory);

    // Calculate distance to nearest boundary
    const distPct = distanceToBoundary(currentPrice, position.lowerPrice, position.upperPrice);

    return {
      position,
      status,
      currentPrice,
      distanceToBoundaryPct: distPct,
      regime,
    };
  }

  /**
   * Determine the status of a position based on current price.
   * - out_of_range: price is outside the range
   * - near_boundary: price is within 10% of a range edge
   * - in_range: price is comfortably within range
   */
  private determineStatus(currentPrice: number, position: Position): PositionStatus {
    if (currentPrice <= position.lowerPrice || currentPrice >= position.upperPrice) {
      return 'out_of_range';
    }

    const nearBoundaryPct = this.config.monitoring.nearBoundaryPct;
    const rangeWidth = position.upperPrice - position.lowerPrice;
    const distToLower = currentPrice - position.lowerPrice;
    const distToUpper = position.upperPrice - currentPrice;
    const minDist = Math.min(distToLower, distToUpper);

    if (minDist / rangeWidth <= nearBoundaryPct) {
      return 'near_boundary';
    }

    return 'in_range';
  }

  /**
   * Record a price observation for a pool.
   */
  private recordPrice(pool: string, price: number): void {
    let history = this.priceHistories.get(pool);
    if (!history) {
      history = [];
      this.priceHistories.set(pool, history);
    }

    history.push(price);

    // Trim to max length
    if (history.length > this.maxHistoryLength) {
      history.splice(0, history.length - this.maxHistoryLength);
    }
  }

  /**
   * Get the price history for a pool.
   */
  getPriceHistory(pool: string): number[] {
    return this.priceHistories.get(pool) ?? [];
  }

  /**
   * Get the market regime for a pool based on collected history.
   */
  getMarketRegime(pool: string): MarketRegime {
    const history = this.priceHistories.get(pool) ?? [];
    return detectMarketRegime(history);
  }

  /**
   * Clear all cached state (useful for testing).
   */
  reset(): void {
    this.previousStatuses.clear();
    this.priceHistories.clear();
  }
}
