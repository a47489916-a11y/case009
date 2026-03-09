/**
 * Circuit breakers and safety checks.
 * Prevents dangerous operations during extreme market conditions.
 */

import { getLogger } from '../utils/logger.ts';
import { standardDeviation } from '../utils/math.ts';
import type { AppConfig, MarketRegime } from '../core/types.ts';

/** Result of a guard check. */
export interface GuardResult {
  allowed: boolean;
  reason: string;
  severity: 'info' | 'warning' | 'critical';
}

/**
 * Circuit breaker and risk guard system.
 */
export class RiskGuards {
  private readonly circuitBreaker24hPct: number;
  private readonly maxSlippageBps: number;
  private readonly maxRebalancesPerDay: number;
  private readonly oracleDeviationPct: number;

  constructor(riskConfig: AppConfig['risk']) {
    this.circuitBreaker24hPct = riskConfig.circuitBreaker24hPct;
    this.maxSlippageBps = riskConfig.maxSlippageBps;
    this.maxRebalancesPerDay = riskConfig.maxRebalancesPerDay;
    this.oracleDeviationPct = riskConfig.oracleDeviationPct;
  }

  /**
   * Check 24h price change circuit breaker.
   * If the 24h price drop exceeds the threshold, trigger emergency exit.
   * @param priceChange24hPct The 24h price change as a percentage (e.g., -15 for 15% drop)
   */
  check24hCircuitBreaker(priceChange24hPct: number): GuardResult {
    if (priceChange24hPct <= -this.circuitBreaker24hPct) {
      return {
        allowed: false,
        reason: `24h price change ${priceChange24hPct.toFixed(1)}% exceeds circuit breaker threshold of -${this.circuitBreaker24hPct}%`,
        severity: 'critical',
      };
    }
    return { allowed: true, reason: 'Price change within normal range', severity: 'info' };
  }

  /**
   * Check if estimated slippage is acceptable.
   * @param slippageBps Estimated slippage in basis points
   */
  checkSlippage(slippageBps: number): GuardResult {
    if (slippageBps > this.maxSlippageBps) {
      return {
        allowed: false,
        reason: `Estimated slippage ${slippageBps}bps exceeds max ${this.maxSlippageBps}bps`,
        severity: 'warning',
      };
    }
    return { allowed: true, reason: 'Slippage within acceptable range', severity: 'info' };
  }

  /**
   * Check daily rebalance count limit.
   * @param todayCount Number of rebalances executed today
   */
  checkDailyLimit(todayCount: number): GuardResult {
    if (todayCount >= this.maxRebalancesPerDay) {
      return {
        allowed: false,
        reason: `Daily rebalance limit reached: ${todayCount}/${this.maxRebalancesPerDay}`,
        severity: 'warning',
      };
    }
    return { allowed: true, reason: `Rebalances today: ${todayCount}/${this.maxRebalancesPerDay}`, severity: 'info' };
  }

  /**
   * Check oracle price deviation between two sources.
   * @param oraclePrice Price from oracle (e.g., Pyth)
   * @param dexPrice Price from the DEX pool
   */
  checkOracleDeviation(oraclePrice: number, dexPrice: number): GuardResult {
    if (oraclePrice <= 0 || dexPrice <= 0) {
      return {
        allowed: false,
        reason: 'Invalid price data (zero or negative)',
        severity: 'critical',
      };
    }

    const deviationPct = Math.abs((oraclePrice - dexPrice) / oraclePrice) * 100;
    if (deviationPct > this.oracleDeviationPct) {
      return {
        allowed: false,
        reason: `Oracle deviation ${deviationPct.toFixed(2)}% exceeds threshold ${this.oracleDeviationPct}%`,
        severity: 'warning',
      };
    }
    return { allowed: true, reason: `Oracle deviation: ${deviationPct.toFixed(2)}%`, severity: 'info' };
  }

  /**
   * Check for 3-sigma price movement.
   * @param prices Recent price history
   */
  checkThreeSigmaEvent(prices: number[]): GuardResult {
    if (prices.length < 30) {
      return { allowed: true, reason: 'Insufficient data for 3-sigma check', severity: 'info' };
    }

    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      const prev = prices[i - 1]!;
      if (prev !== 0) {
        returns.push((prices[i]! - prev) / prev);
      }
    }

    if (returns.length === 0) {
      return { allowed: true, reason: 'No return data available', severity: 'info' };
    }

    const lastReturn = returns[returns.length - 1]!;
    const stdDev = standardDeviation(returns);

    if (stdDev > 0 && Math.abs(lastReturn) > 3 * stdDev) {
      return {
        allowed: false,
        reason: `3-sigma event detected: price move ${(lastReturn * 100).toFixed(2)}% (3sigma = ${(3 * stdDev * 100).toFixed(2)}%)`,
        severity: 'critical',
      };
    }

    return { allowed: true, reason: 'No extreme price movements detected', severity: 'info' };
  }

  /**
   * Check that a tick range respects minimum width.
   * @param lowerTick Lower tick index
   * @param upperTick Upper tick index
   * @param tickSpacing Pool's tick spacing
   */
  checkTickSpacing(lowerTick: number, upperTick: number, tickSpacing: number): GuardResult {
    const minWidth = tickSpacing * 2;
    const actualWidth = upperTick - lowerTick;

    if (actualWidth < minWidth) {
      return {
        allowed: false,
        reason: `Tick range width ${actualWidth} is less than minimum ${minWidth} (tickSpacing=${tickSpacing} * 2)`,
        severity: 'warning',
      };
    }
    return { allowed: true, reason: 'Tick range width is valid', severity: 'info' };
  }

  /**
   * Run all applicable guard checks for a rebalance operation.
   * Returns the first failing check, or a passing result if all pass.
   */
  runAllChecks(params: {
    priceChange24hPct: number;
    estimatedSlippageBps: number;
    todayRebalanceCount: number;
    oraclePrice: number;
    dexPrice: number;
    prices: number[];
    lowerTick?: number;
    upperTick?: number;
    tickSpacing?: number;
  }): GuardResult {
    const logger = getLogger();

    const checks: GuardResult[] = [
      this.check24hCircuitBreaker(params.priceChange24hPct),
      this.checkSlippage(params.estimatedSlippageBps),
      this.checkDailyLimit(params.todayRebalanceCount),
      this.checkOracleDeviation(params.oraclePrice, params.dexPrice),
      this.checkThreeSigmaEvent(params.prices),
    ];

    if (params.lowerTick != null && params.upperTick != null && params.tickSpacing != null) {
      checks.push(this.checkTickSpacing(params.lowerTick, params.upperTick, params.tickSpacing));
    }

    for (const check of checks) {
      if (!check.allowed) {
        logger.warn('Guard check failed', { reason: check.reason, severity: check.severity });
        return check;
      }
    }

    return { allowed: true, reason: 'All guard checks passed', severity: 'info' };
  }
}
