/**
 * Tests for risk management: circuit breakers, cooldown logic, gas estimation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RiskGuards } from '../src/risk/guards.ts';
import { CooldownManager } from '../src/risk/cooldown.ts';
import { GasEstimator } from '../src/risk/gas-estimator.ts';
import type { AppConfig } from '../src/core/types.ts';

const defaultRiskConfig: AppConfig['risk'] = {
  maxRebalancesPerDay: 6,
  cooldownHours: 4,
  circuitBreaker24hPct: 15,
  maxSlippageBps: 50,
  oracleDeviationPct: 2,
  minWaitHoursOutOfRange: 4,
  maxWaitHoursOutOfRange: 12,
  costToFeeThreshold: 0.5,
};

describe('RiskGuards', () => {
  let guards: RiskGuards;

  beforeEach(() => {
    guards = new RiskGuards(defaultRiskConfig);
  });

  describe('check24hCircuitBreaker', () => {
    it('should allow normal price changes', () => {
      expect(guards.check24hCircuitBreaker(-5).allowed).toBe(true);
      expect(guards.check24hCircuitBreaker(10).allowed).toBe(true);
      expect(guards.check24hCircuitBreaker(0).allowed).toBe(true);
    });

    it('should block when 24h drop exceeds threshold', () => {
      const result = guards.check24hCircuitBreaker(-15);
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('should block when drop is exactly at threshold', () => {
      const result = guards.check24hCircuitBreaker(-15);
      expect(result.allowed).toBe(false);
    });

    it('should block for extreme drops', () => {
      const result = guards.check24hCircuitBreaker(-50);
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('critical');
    });
  });

  describe('checkSlippage', () => {
    it('should allow slippage within limits', () => {
      expect(guards.checkSlippage(30).allowed).toBe(true);
      expect(guards.checkSlippage(50).allowed).toBe(true);
    });

    it('should block excessive slippage', () => {
      const result = guards.checkSlippage(51);
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('warning');
    });
  });

  describe('checkDailyLimit', () => {
    it('should allow when under limit', () => {
      expect(guards.checkDailyLimit(0).allowed).toBe(true);
      expect(guards.checkDailyLimit(5).allowed).toBe(true);
    });

    it('should block when at or over limit', () => {
      const result = guards.checkDailyLimit(6);
      expect(result.allowed).toBe(false);
    });

    it('should block when well over limit', () => {
      expect(guards.checkDailyLimit(10).allowed).toBe(false);
    });
  });

  describe('checkOracleDeviation', () => {
    it('should allow small deviations', () => {
      expect(guards.checkOracleDeviation(100, 100.5).allowed).toBe(true);
      expect(guards.checkOracleDeviation(100, 99.5).allowed).toBe(true);
    });

    it('should block large deviations', () => {
      const result = guards.checkOracleDeviation(100, 103);
      expect(result.allowed).toBe(false);
    });

    it('should block on zero prices', () => {
      expect(guards.checkOracleDeviation(0, 100).allowed).toBe(false);
      expect(guards.checkOracleDeviation(100, 0).allowed).toBe(false);
    });

    it('should handle exact threshold (2%)', () => {
      // 2% deviation should be acceptable (> threshold triggers block)
      const result = guards.checkOracleDeviation(100, 102);
      expect(result.allowed).toBe(true);
    });

    it('should block just over threshold', () => {
      const result = guards.checkOracleDeviation(100, 102.1);
      expect(result.allowed).toBe(false);
    });
  });

  describe('checkThreeSigmaEvent', () => {
    it('should allow with insufficient data', () => {
      expect(guards.checkThreeSigmaEvent([100, 101]).allowed).toBe(true);
    });

    it('should allow normal price movements', () => {
      const prices = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 0.5);
      const result = guards.checkThreeSigmaEvent(prices);
      expect(result.allowed).toBe(true);
    });

    it('should detect 3-sigma events', () => {
      // Create normal prices then add extreme move
      const prices = Array.from({ length: 50 }, () => 100 + (Math.random() - 0.5) * 0.2);
      prices.push(115); // Massive spike
      const result = guards.checkThreeSigmaEvent(prices);
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('critical');
    });
  });

  describe('checkTickSpacing', () => {
    it('should accept valid ranges', () => {
      expect(guards.checkTickSpacing(0, 200, 64).allowed).toBe(true);
    });

    it('should reject narrow ranges', () => {
      const result = guards.checkTickSpacing(0, 64, 64);
      expect(result.allowed).toBe(false);
    });
  });

  describe('runAllChecks', () => {
    it('should pass when all checks are valid', () => {
      const result = guards.runAllChecks({
        priceChange24hPct: -5,
        estimatedSlippageBps: 30,
        todayRebalanceCount: 2,
        oraclePrice: 100,
        dexPrice: 100.5,
        prices: Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 0.5),
      });
      expect(result.allowed).toBe(true);
    });

    it('should fail on first failing check', () => {
      const result = guards.runAllChecks({
        priceChange24hPct: -20, // This should fail
        estimatedSlippageBps: 30,
        todayRebalanceCount: 2,
        oraclePrice: 100,
        dexPrice: 100.5,
        prices: [],
      });
      expect(result.allowed).toBe(false);
      expect(result.severity).toBe('critical');
    });

    it('should include tick spacing check when provided', () => {
      const result = guards.runAllChecks({
        priceChange24hPct: 0,
        estimatedSlippageBps: 10,
        todayRebalanceCount: 0,
        oraclePrice: 100,
        dexPrice: 100,
        prices: [],
        lowerTick: 0,
        upperTick: 64,
        tickSpacing: 64,
      });
      expect(result.allowed).toBe(false); // Too narrow
    });
  });
});

describe('CooldownManager', () => {
  let cooldown: CooldownManager;

  beforeEach(() => {
    cooldown = new CooldownManager({
      cooldownHours: 4,
      maxRebalancesPerDay: 6,
    });
  });

  it('should allow rebalance when no history exists', () => {
    const result = cooldown.canRebalance('pos-1');
    expect(result.allowed).toBe(true);
  });

  it('should block rebalance within cooldown period', () => {
    cooldown.recordRebalance('pos-1');
    const result = cooldown.canRebalance('pos-1');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Cooldown active');
  });

  it('should track daily count', () => {
    // Record 6 rebalances
    for (let i = 0; i < 6; i++) {
      cooldown.recordRebalance(`pos-${i}`);
    }

    // 7th should be blocked by daily limit
    const result = cooldown.canRebalance('pos-new');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily rebalance limit');
  });

  it('should allow different positions independently', () => {
    cooldown.recordRebalance('pos-1');

    // pos-2 should still be allowed (different position, no cooldown)
    const result = cooldown.canRebalance('pos-2');
    // May be blocked by daily limit if it counts; but with limit=6 and 1 rebalance, should pass
    expect(result.allowed).toBe(true);
  });

  it('should return remaining cooldown time', () => {
    cooldown.recordRebalance('pos-1');
    const remaining = cooldown.getRemainingCooldownMs('pos-1');
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(4 * 3600_000);
  });

  it('should return 0 cooldown for unknown positions', () => {
    expect(cooldown.getRemainingCooldownMs('unknown')).toBe(0);
  });

  it('should reset daily count', () => {
    for (let i = 0; i < 6; i++) {
      cooldown.recordRebalance(`pos-${i}`);
    }

    cooldown.resetDailyCount();
    const result = cooldown.canRebalance('pos-new');
    // After reset, daily limit should not block (but cooldown still active for same positions)
    // pos-new has no cooldown, so it should be allowed
    expect(result.allowed).toBe(true);
  });
});

describe('GasEstimator', () => {
  let estimator: GasEstimator;

  beforeEach(() => {
    estimator = new GasEstimator();
    estimator.updatePrices(150, 1.5); // SOL=$150, SUI=$1.50
  });

  it('should estimate Solana rebalance cost', () => {
    const estimate = estimator.estimateRebalanceCost('solana');
    expect(estimate.chain).toBe('solana');
    expect(estimate.totalUsd).toBeGreaterThan(0);
    expect(estimate.totalLamportsOrMist).toBeGreaterThan(0n);
    expect(estimate.baseFee).toBeGreaterThan(0);
  });

  it('should estimate SUI rebalance cost', () => {
    const estimate = estimator.estimateRebalanceCost('sui');
    expect(estimate.chain).toBe('sui');
    expect(estimate.totalUsd).toBeGreaterThan(0);
    expect(estimate.totalLamportsOrMist).toBeGreaterThanOrEqual(0n);
  });

  it('should return 0 USD when prices not set', () => {
    const freshEstimator = new GasEstimator();
    const estimate = freshEstimator.estimateRebalanceCost('solana');
    expect(estimate.totalUsd).toBe(0);
    expect(estimate.totalLamportsOrMist).toBeGreaterThan(0n); // lamports still calculated
  });

  it('should correctly assess cost justification', () => {
    // Cost of $1 against $10 expected income → justified (10%)
    expect(estimator.isCostJustified(1, 10, 0.5)).toBe(true);

    // Cost of $6 against $10 expected income → not justified (60%)
    expect(estimator.isCostJustified(6, 10, 0.5)).toBe(false);

    // Exactly at threshold
    expect(estimator.isCostJustified(5, 10, 0.5)).toBe(true);

    // Zero expected income
    expect(estimator.isCostJustified(1, 0, 0.5)).toBe(false);
  });

  it('should update prices correctly', () => {
    estimator.updatePrices(200, 2.0);
    const solEstimate = estimator.estimateRebalanceCost('solana');
    const suiEstimate = estimator.estimateRebalanceCost('sui');

    // Higher SOL price should give higher USD cost for same lamports
    expect(solEstimate.totalUsd).toBeGreaterThan(0);
    expect(suiEstimate.totalUsd).toBeGreaterThan(0);
  });
});
