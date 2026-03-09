/**
 * Bollinger Band strategy.
 * Uses 20-period Bollinger Bands with 2 standard deviations for range boundaries.
 */

import { calculateBollingerBands } from '../utils/math.ts';
import type { MarketRegime, RangeStrategy } from '../core/types.ts';

/**
 * Bollinger Band range strategy.
 * Sets position range to the upper and lower Bollinger Bands.
 */
export class BollingerStrategy implements RangeStrategy {
  readonly name = 'bollinger' as const;

  private readonly period: number;
  private readonly numStdDev: number;

  constructor(params: Record<string, number> = {}) {
    this.period = params.bollingerPeriod ?? 20;
    this.numStdDev = params.bollingerStdDev ?? 2.0;
  }

  /**
   * Calculate range using Bollinger Bands.
   * Falls back to +/- 10% if insufficient price data.
   */
  calculateRange(params: {
    currentPrice: number;
    prices: number[];
    regime: MarketRegime;
  }): { lower: number; upper: number } {
    const { currentPrice, prices, regime } = params;

    // If extreme regime, use tight range to signal closure
    if (regime.regime === 'extreme') {
      return {
        lower: currentPrice * 0.999,
        upper: currentPrice * 1.001,
      };
    }

    // Need at least `period` data points for Bollinger calculation
    if (prices.length < this.period) {
      // Fallback to simple +/- 10%
      return {
        lower: currentPrice * 0.90,
        upper: currentPrice * 1.10,
      };
    }

    // Adjust std dev multiplier based on regime
    let effectiveStdDev = this.numStdDev;
    switch (regime.regime) {
      case 'low_vol':
        effectiveStdDev *= 0.8; // Tighter bands in low vol
        break;
      case 'high_vol':
        effectiveStdDev *= 1.3; // Wider bands in high vol
        break;
      case 'normal':
      default:
        break;
    }

    const bands = calculateBollingerBands(prices, this.period, effectiveStdDev);

    // Ensure lower bound is positive
    const lower = Math.max(bands.lower, currentPrice * 0.01);

    return {
      lower,
      upper: bands.upper,
    };
  }
}
