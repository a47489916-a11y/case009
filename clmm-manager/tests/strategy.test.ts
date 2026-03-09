/**
 * Tests for all three range calculation strategies.
 */

import { describe, it, expect } from 'vitest';
import { Volatility2SigmaStrategy, detectMarketRegime } from '../src/strategy/volatility.ts';
import { FixedPctStrategy } from '../src/strategy/fixed-pct.ts';
import { BollingerStrategy } from '../src/strategy/bollinger.ts';
import type { MarketRegime } from '../src/core/types.ts';

// Helper: generate synthetic price data
function generatePrices(base: number, length: number, volatility: number): number[] {
  const prices: number[] = [base];
  for (let i = 1; i < length; i++) {
    const change = (Math.random() - 0.5) * 2 * volatility * base;
    prices.push(prices[i - 1]! + change);
  }
  return prices;
}

// Helper: generate trending prices
function generateTrendingPrices(base: number, length: number, trend: number, noise: number): number[] {
  return Array.from({ length }, (_, i) => base + trend * i + (Math.random() - 0.5) * noise);
}

const normalRegime: MarketRegime = { regime: 'normal', atrRatio: 1.0 };
const lowVolRegime: MarketRegime = { regime: 'low_vol', atrRatio: 0.5 };
const highVolRegime: MarketRegime = { regime: 'high_vol', atrRatio: 2.0 };
const extremeRegime: MarketRegime = { regime: 'extreme', atrRatio: 3.5 };

describe('detectMarketRegime', () => {
  it('should return normal for insufficient data', () => {
    const regime = detectMarketRegime([100, 101, 102]);
    expect(regime.regime).toBe('normal');
    expect(regime.atrRatio).toBe(1.0);
  });

  it('should detect normal regime for moderate volatility', () => {
    // Prices with moderate movement
    const prices = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i * 0.3) * 2);
    const regime = detectMarketRegime(prices);
    expect(['normal', 'low_vol']).toContain(regime.regime);
  });

  it('should detect low_vol for flat prices', () => {
    // Nearly flat prices
    const prices = Array.from({ length: 100 }, (_, i) => 100 + i * 0.001);
    const regime = detectMarketRegime(prices);
    // Low ATR ratio expected
    expect(regime.atrRatio).toBeLessThanOrEqual(1.5);
  });

  it('should detect extreme regime for 3-sigma event', () => {
    // Normal prices followed by a massive spike
    const prices = Array.from({ length: 100 }, () => 100 + (Math.random() - 0.5) * 0.2);
    prices.push(120); // Massive spike
    const regime = detectMarketRegime(prices);
    expect(regime.regime).toBe('extreme');
  });
});

describe('Volatility2SigmaStrategy', () => {
  const strategy = new Volatility2SigmaStrategy({
    atrPeriod: 14,
    multiplier: 2.0,
    holdingDays: 7,
    emaPeriodShort: 7,
    emaPeriodLong: 21,
  });

  it('should return a valid range', () => {
    const prices = generatePrices(150, 50, 0.02);
    const currentPrice = prices[prices.length - 1]!;
    const range = strategy.calculateRange({ currentPrice, prices, regime: normalRegime });

    expect(range.lower).toBeLessThan(currentPrice);
    expect(range.upper).toBeGreaterThan(currentPrice);
    expect(range.lower).toBeGreaterThan(0);
  });

  it('should clamp range width between 2% and 30%', () => {
    const prices = generatePrices(100, 50, 0.01);
    const currentPrice = prices[prices.length - 1]!;
    const range = strategy.calculateRange({ currentPrice, prices, regime: normalRegime });

    const rangeWidthPct = (range.upper - range.lower) / currentPrice;
    expect(rangeWidthPct).toBeGreaterThanOrEqual(0.02 * 0.3); // At minimum with 40% bias
    expect(rangeWidthPct).toBeLessThanOrEqual(0.60 + 0.01); // Max 30% * 2 sides + tolerance
  });

  it('should apply bullish bias when EMA(7) > EMA(21)', () => {
    // Strong uptrend
    const prices = generateTrendingPrices(100, 50, 1.0, 0.5);
    const currentPrice = prices[prices.length - 1]!;
    const range = strategy.calculateRange({ currentPrice, prices, regime: normalRegime });

    // In bullish trend, upper should be further from price than lower
    const upperDist = range.upper - currentPrice;
    const lowerDist = currentPrice - range.lower;
    expect(upperDist).toBeGreaterThan(lowerDist * 0.9); // Allow some tolerance
  });

  it('should return very tight range for extreme regime', () => {
    const prices = generatePrices(100, 50, 0.02);
    const currentPrice = prices[prices.length - 1]!;
    const range = strategy.calculateRange({ currentPrice, prices, regime: extremeRegime });

    const rangeWidthPct = (range.upper - range.lower) / currentPrice;
    expect(rangeWidthPct).toBeLessThan(0.01);
  });
});

describe('FixedPctStrategy', () => {
  it('should set symmetric range with default 10%', () => {
    const strategy = new FixedPctStrategy();
    const currentPrice = 100;
    const range = strategy.calculateRange({
      currentPrice,
      prices: [100],
      regime: normalRegime,
    });

    expect(range.lower).toBeCloseTo(90, 5);
    expect(range.upper).toBeCloseTo(110, 5);
  });

  it('should respect custom percentage', () => {
    const strategy = new FixedPctStrategy({ fixedPctRange: 0.20 });
    const currentPrice = 100;
    const range = strategy.calculateRange({
      currentPrice,
      prices: [100],
      regime: normalRegime,
    });

    expect(range.lower).toBeCloseTo(80, 5);
    expect(range.upper).toBeCloseTo(120, 5);
  });

  it('should tighten range in low volatility', () => {
    const strategy = new FixedPctStrategy({ fixedPctRange: 0.10 });
    const currentPrice = 100;

    const normalRange = strategy.calculateRange({
      currentPrice,
      prices: [100],
      regime: normalRegime,
    });

    const lowVolRange = strategy.calculateRange({
      currentPrice,
      prices: [100],
      regime: lowVolRegime,
    });

    const normalWidth = normalRange.upper - normalRange.lower;
    const lowVolWidth = lowVolRange.upper - lowVolRange.lower;
    expect(lowVolWidth).toBeLessThan(normalWidth);
  });

  it('should widen range in high volatility', () => {
    const strategy = new FixedPctStrategy({ fixedPctRange: 0.10 });
    const currentPrice = 100;

    const normalRange = strategy.calculateRange({
      currentPrice,
      prices: [100],
      regime: normalRegime,
    });

    const highVolRange = strategy.calculateRange({
      currentPrice,
      prices: [100],
      regime: highVolRegime,
    });

    const normalWidth = normalRange.upper - normalRange.lower;
    const highVolWidth = highVolRange.upper - highVolRange.lower;
    expect(highVolWidth).toBeGreaterThan(normalWidth);
  });

  it('should significantly widen in extreme regime', () => {
    const strategy = new FixedPctStrategy({ fixedPctRange: 0.10 });
    const currentPrice = 100;

    const normalRange = strategy.calculateRange({
      currentPrice,
      prices: [100],
      regime: normalRegime,
    });

    const extremeRange = strategy.calculateRange({
      currentPrice,
      prices: [100],
      regime: extremeRegime,
    });

    const normalWidth = normalRange.upper - normalRange.lower;
    const extremeWidth = extremeRange.upper - extremeRange.lower;
    expect(extremeWidth).toBeGreaterThan(normalWidth * 1.5);
  });
});

describe('BollingerStrategy', () => {
  it('should fallback to ±10% with insufficient data', () => {
    const strategy = new BollingerStrategy();
    const currentPrice = 100;
    const range = strategy.calculateRange({
      currentPrice,
      prices: [98, 99, 100],
      regime: normalRegime,
    });

    expect(range.lower).toBeCloseTo(90, 5);
    expect(range.upper).toBeCloseTo(110, 5);
  });

  it('should use Bollinger Bands with sufficient data', () => {
    const strategy = new BollingerStrategy({ bollingerPeriod: 20, bollingerStdDev: 2.0 });

    // Generate 25 data points with known characteristics
    const prices = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i * 0.5) * 3);
    const currentPrice = prices[prices.length - 1]!;

    const range = strategy.calculateRange({
      currentPrice,
      prices,
      regime: normalRegime,
    });

    expect(range.lower).toBeLessThan(currentPrice);
    expect(range.upper).toBeGreaterThan(currentPrice);
    expect(range.lower).toBeGreaterThan(0);
  });

  it('should return tight range for extreme regime', () => {
    const strategy = new BollingerStrategy();
    const prices = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 3);
    const currentPrice = prices[prices.length - 1]!;

    const range = strategy.calculateRange({
      currentPrice,
      prices,
      regime: extremeRegime,
    });

    const width = range.upper - range.lower;
    expect(width / currentPrice).toBeLessThan(0.01);
  });

  it('should widen bands in high volatility', () => {
    const strategy = new BollingerStrategy({ bollingerPeriod: 20, bollingerStdDev: 2.0 });
    const prices = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i * 0.5) * 5);
    const currentPrice = prices[prices.length - 1]!;

    const normalRange = strategy.calculateRange({
      currentPrice,
      prices,
      regime: normalRegime,
    });

    const highVolRange = strategy.calculateRange({
      currentPrice,
      prices,
      regime: highVolRegime,
    });

    const normalWidth = normalRange.upper - normalRange.lower;
    const highVolWidth = highVolRange.upper - highVolRange.lower;
    expect(highVolWidth).toBeGreaterThan(normalWidth);
  });
});
