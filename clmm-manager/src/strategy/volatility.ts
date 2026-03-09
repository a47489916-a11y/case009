/**
 * Volatility-linked 2-sigma strategy.
 *
 * Range width = ATR(14) * 2.0 * sqrt(holdingDays)
 * Clamped to [0.02, 0.30]
 *
 * Trend bias: EMA(7) > EMA(21) → shift upper 60%, lower 40%
 *             else → shift lower 60%, upper 40%
 *
 * Market regime detection:
 *   atrRatio = currentATR / avgATR(90d)
 *   < 0.7 → low_vol
 *   0.7-1.5 → normal
 *   > 1.5 → high_vol
 *   3-sigma event → extreme
 */

import { calculateATR, calculateATRRatio, calculateEMA, clamp, standardDeviation } from '../utils/math.ts';
import type { MarketRegime, RangeStrategy } from '../core/types.ts';

/**
 * Detect the current market regime based on ATR analysis.
 * @param prices Historical closing prices (most recent last)
 * @param atrPeriod ATR calculation period
 * @returns MarketRegime classification
 */
export function detectMarketRegime(prices: number[], atrPeriod = 14): MarketRegime {
  if (prices.length < 90) {
    return { regime: 'normal', atrRatio: 1.0 };
  }

  // Current ATR
  const currentATR = calculateATR(prices, atrPeriod);

  // 90-day average ATR: compute ATR for rolling windows then average
  const windowSize = Math.min(90, prices.length);
  const longTermPrices = prices.slice(-windowSize);
  const avgATR = calculateATR(longTermPrices, atrPeriod);

  if (avgATR === 0) {
    return { regime: 'normal', atrRatio: 1.0 };
  }

  const atrRatio = currentATR / avgATR;

  // Check for 3-sigma event: the most recent price change
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]!;
    if (prev !== 0) {
      returns.push((prices[i]! - prev) / prev);
    }
  }

  const lastReturn = returns[returns.length - 1] ?? 0;
  const stdDev = standardDeviation(returns);
  const isThreeSigma = Math.abs(lastReturn) > 3 * stdDev && stdDev > 0;

  if (isThreeSigma) {
    return { regime: 'extreme', atrRatio };
  }

  if (atrRatio < 0.7) {
    return { regime: 'low_vol', atrRatio };
  } else if (atrRatio <= 1.5) {
    return { regime: 'normal', atrRatio };
  } else {
    return { regime: 'high_vol', atrRatio };
  }
}

/**
 * Volatility-linked 2-sigma range strategy implementation.
 */
export class Volatility2SigmaStrategy implements RangeStrategy {
  readonly name = 'volatility_2sigma' as const;

  private readonly atrPeriod: number;
  private readonly multiplier: number;
  private readonly holdingDays: number;
  private readonly emaPeriodShort: number;
  private readonly emaPeriodLong: number;

  constructor(params: Record<string, number> = {}) {
    this.atrPeriod = params.atrPeriod ?? 14;
    this.multiplier = params.multiplier ?? 2.0;
    this.holdingDays = params.holdingDays ?? 7;
    this.emaPeriodShort = params.emaPeriodShort ?? 7;
    this.emaPeriodLong = params.emaPeriodLong ?? 21;
  }

  /**
   * Calculate the optimal price range using 2-sigma volatility logic.
   * @param params Current price, historical prices, and market regime
   * @returns Lower and upper price bounds
   */
  calculateRange(params: {
    currentPrice: number;
    prices: number[];
    regime: MarketRegime;
  }): { lower: number; upper: number } {
    const { currentPrice, prices, regime } = params;

    // If extreme regime, return a very tight range to signal position closure
    if (regime.regime === 'extreme') {
      return {
        lower: currentPrice * 0.999,
        upper: currentPrice * 1.001,
      };
    }

    // Calculate range width from ATR
    const atrRatio = calculateATRRatio(prices, this.atrPeriod);
    let rangeWidth = atrRatio * this.multiplier * Math.sqrt(this.holdingDays);
    rangeWidth = clamp(rangeWidth, 0.02, 0.30);

    // Trend bias using EMA crossover
    const emaShort = calculateEMA(prices, this.emaPeriodShort);
    const emaLong = calculateEMA(prices, this.emaPeriodLong);
    const isBullish = emaShort > emaLong;

    // Bias: 60% of range on the trend side, 40% on the counter-trend side
    const upperPct = isBullish ? rangeWidth * 0.6 : rangeWidth * 0.4;
    const lowerPct = isBullish ? rangeWidth * 0.4 : rangeWidth * 0.6;

    return {
      lower: currentPrice * (1 - lowerPct),
      upper: currentPrice * (1 + upperPct),
    };
  }
}
