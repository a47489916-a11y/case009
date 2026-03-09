/**
 * Fixed percentage range strategy.
 * Sets a symmetric range of +/- configurable percentage around the current price.
 */

import type { MarketRegime, RangeStrategy } from '../core/types.ts';

/**
 * Simple fixed-percentage range strategy.
 * Default range is +/- 10% of current price.
 */
export class FixedPctStrategy implements RangeStrategy {
  readonly name = 'fixed_pct' as const;

  private readonly rangePct: number;

  constructor(params: Record<string, number> = {}) {
    this.rangePct = params.fixedPctRange ?? 0.10;
  }

  /**
   * Calculate a symmetric percentage range around the current price.
   * Widens range slightly in high volatility regimes.
   */
  calculateRange(params: {
    currentPrice: number;
    prices: number[];
    regime: MarketRegime;
  }): { lower: number; upper: number } {
    const { currentPrice, regime } = params;

    // Adjust range based on market regime
    let effectivePct = this.rangePct;
    switch (regime.regime) {
      case 'low_vol':
        effectivePct *= 0.75; // Tighten in low vol
        break;
      case 'high_vol':
        effectivePct *= 1.5; // Widen in high vol
        break;
      case 'extreme':
        effectivePct *= 2.0; // Significantly widen in extreme
        break;
      case 'normal':
      default:
        break;
    }

    return {
      lower: currentPrice * (1 - effectivePct),
      upper: currentPrice * (1 + effectivePct),
    };
  }
}
