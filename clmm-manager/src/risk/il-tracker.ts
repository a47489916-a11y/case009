/**
 * Impermanent loss tracking across positions.
 * Stores historical IL data in SQLite for analysis.
 */

import { getLogger } from '../utils/logger.ts';
import { calculateIL, calculateILUsd } from '../utils/math.ts';
import { insertILSnapshot, getILHistory, getCumulativeIL } from '../utils/db.ts';
import type { Position, ILSnapshot } from '../core/types.ts';

/**
 * Tracks impermanent loss per position over time.
 */
export class ILTracker {
  /**
   * Record an IL snapshot for a position.
   * Compares position value to what a HODL strategy would have yielded.
   *
   * @param position The current position state
   * @param currentPrice Current market price of the token pair
   * @param entryPrice Price at which the position was opened
   */
  recordSnapshot(position: Position, currentPrice: number, entryPrice: number): ILSnapshot {
    const logger = getLogger();

    const ilPct = calculateIL(entryPrice, currentPrice);
    const ilUsd = calculateILUsd(position.depositedValueUsd, entryPrice, currentPrice);

    // HODL value: what would the original deposit be worth without LP
    const priceRatio = currentPrice / entryPrice;
    const hodlValueUsd = position.depositedValueUsd * ((1 + priceRatio) / 2);

    const snapshot: ILSnapshot = {
      positionId: position.id,
      timestamp: new Date(),
      positionValueUsd: position.currentValueUsd,
      hodlValueUsd,
      ilPct,
      ilUsd,
    };

    // Store in database
    try {
      insertILSnapshot({
        position_id: position.id,
        timestamp: snapshot.timestamp.toISOString(),
        position_value_usd: snapshot.positionValueUsd,
        hodl_value_usd: snapshot.hodlValueUsd,
        il_pct: snapshot.ilPct,
        il_usd: snapshot.ilUsd,
      });
    } catch (err) {
      logger.error('Failed to store IL snapshot', {
        positionId: position.id,
        error: (err as Error).message,
      });
    }

    logger.debug('IL snapshot recorded', {
      positionId: position.id,
      ilPct: (ilPct * 100).toFixed(3) + '%',
      ilUsd: ilUsd.toFixed(2),
      positionValue: position.currentValueUsd.toFixed(2),
      hodlValue: hodlValueUsd.toFixed(2),
    });

    return snapshot;
  }

  /**
   * Get the IL history for a position.
   * @param positionId Position identifier
   * @returns Array of IL snapshots ordered by timestamp
   */
  getHistory(positionId: string): ILSnapshot[] {
    try {
      const rows = getILHistory(positionId);
      return rows.map((row) => ({
        positionId,
        timestamp: new Date(row.timestamp),
        positionValueUsd: row.position_value_usd,
        hodlValueUsd: row.hodl_value_usd,
        ilPct: row.il_pct,
        ilUsd: row.il_usd,
      }));
    } catch (err) {
      getLogger().error('Failed to fetch IL history', {
        positionId,
        error: (err as Error).message,
      });
      return [];
    }
  }

  /**
   * Get cumulative IL across all positions.
   * @returns Total IL in USD
   */
  getCumulativeIL(): number {
    try {
      return getCumulativeIL();
    } catch (err) {
      getLogger().error('Failed to compute cumulative IL', {
        error: (err as Error).message,
      });
      return 0;
    }
  }

  /**
   * Calculate net PnL for a position (fees earned minus IL).
   * @param position Position to analyze
   * @param currentPrice Current market price
   * @param entryPrice Entry price when position was opened
   * @returns Net PnL in USD
   */
  calculateNetPnL(position: Position, currentPrice: number, entryPrice: number): number {
    const ilUsd = calculateILUsd(position.depositedValueUsd, entryPrice, currentPrice);
    return position.feesEarnedUsd + ilUsd; // ilUsd is negative
  }
}
