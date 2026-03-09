/**
 * Tests for math utilities: tick/price conversions, IL calculation, ATR, EMA, Bollinger.
 */

import { describe, it, expect } from 'vitest';
import {
  tickToPrice,
  priceToTick,
  sqrtPriceX64ToPrice,
  priceToSqrtPriceX64,
  pctRangeToTicks,
  isValidTickRange,
  calculateIL,
  calculateILUsd,
  calculateATR,
  calculateATRRatio,
  calculateEMA,
  calculateBollingerBands,
  clamp,
  distanceToBoundary,
  standardDeviation,
} from '../src/utils/math.ts';

describe('tickToPrice / priceToTick', () => {
  it('should convert tick 0 to price 1.0', () => {
    expect(tickToPrice(0)).toBeCloseTo(1.0, 10);
  });

  it('should convert positive ticks to prices > 1', () => {
    const price = tickToPrice(10000);
    expect(price).toBeGreaterThan(1);
    expect(price).toBeCloseTo(Math.pow(1.0001, 10000), 2);
  });

  it('should convert negative ticks to prices < 1', () => {
    const price = tickToPrice(-10000);
    expect(price).toBeLessThan(1);
    expect(price).toBeGreaterThan(0);
  });

  it('should round-trip tick -> price -> tick', () => {
    const originalTick = 12345;
    const price = tickToPrice(originalTick);
    const recoveredTick = priceToTick(price);
    expect(recoveredTick).toBe(originalTick);
  });

  it('should round-trip price -> tick -> price with small error', () => {
    const originalPrice = 150.0;
    const tick = priceToTick(originalPrice);
    const recoveredPrice = tickToPrice(tick);
    // Price should be close but may differ by up to one tick's worth
    expect(recoveredPrice).toBeCloseTo(originalPrice, 1);
  });

  it('should throw for non-positive price', () => {
    expect(() => priceToTick(0)).toThrow('Price must be positive');
    expect(() => priceToTick(-5)).toThrow('Price must be positive');
  });
});

describe('sqrtPriceX64 conversions', () => {
  it('should convert sqrtPriceX64 to price', () => {
    // sqrtPriceX64 for price = 1.0 is exactly 2^64
    const q64 = BigInt(1) << BigInt(64);
    const price = sqrtPriceX64ToPrice(q64);
    expect(price).toBeCloseTo(1.0, 5);
  });

  it('should convert price to sqrtPriceX64 and back', () => {
    const originalPrice = 100.0;
    const sqrtPriceX64 = priceToSqrtPriceX64(originalPrice);
    const recoveredPrice = sqrtPriceX64ToPrice(sqrtPriceX64);
    expect(recoveredPrice).toBeCloseTo(originalPrice, 2);
  });

  it('should throw for negative price in priceToSqrtPriceX64', () => {
    expect(() => priceToSqrtPriceX64(-1)).toThrow('Price must be non-negative');
  });

  it('should handle very small prices', () => {
    const smallPrice = 0.001;
    const sqrtPriceX64 = priceToSqrtPriceX64(smallPrice);
    const recovered = sqrtPriceX64ToPrice(sqrtPriceX64);
    expect(recovered).toBeCloseTo(smallPrice, 4);
  });
});

describe('pctRangeToTicks', () => {
  it('should calculate tick range for ±10% around a price', () => {
    const { lowerTick, upperTick } = pctRangeToTicks(100, 0.1, 0.1, 1);
    const lowerPrice = tickToPrice(lowerTick);
    const upperPrice = tickToPrice(upperTick);
    expect(lowerPrice).toBeCloseTo(90, 0);
    expect(upperPrice).toBeCloseTo(110, 0);
  });

  it('should snap ticks to tick spacing', () => {
    const tickSpacing = 64;
    const { lowerTick, upperTick } = pctRangeToTicks(100, 0.05, 0.05, tickSpacing);
    expect(lowerTick % tickSpacing).toBe(0);
    expect(upperTick % tickSpacing).toBe(0);
  });
});

describe('isValidTickRange', () => {
  it('should accept ranges wider than tickSpacing * 2', () => {
    expect(isValidTickRange(0, 200, 64)).toBe(true);
  });

  it('should reject ranges narrower than tickSpacing * 2', () => {
    expect(isValidTickRange(0, 100, 64)).toBe(false);
  });

  it('should accept ranges exactly at minimum width', () => {
    expect(isValidTickRange(0, 128, 64)).toBe(true);
  });
});

describe('calculateIL', () => {
  it('should return 0 when price has not changed', () => {
    const il = calculateIL(100, 100);
    expect(il).toBeCloseTo(0, 10);
  });

  it('should return negative value when price changes', () => {
    // 2x price increase should give ~5.72% IL
    const il = calculateIL(100, 200);
    expect(il).toBeLessThan(0);
    expect(il).toBeCloseTo(-0.05719, 4);
  });

  it('should return same IL for equivalent price move up or down', () => {
    // IL depends on the ratio, so 2x up and 0.5x should give same IL magnitude
    const ilUp = calculateIL(100, 200);
    const ilDown = calculateIL(100, 50);
    expect(ilUp).toBeCloseTo(ilDown, 10);
  });

  it('should throw for non-positive prices', () => {
    expect(() => calculateIL(0, 100)).toThrow('Prices must be positive');
    expect(() => calculateIL(100, -1)).toThrow('Prices must be positive');
  });
});

describe('calculateILUsd', () => {
  it('should return IL in USD terms', () => {
    const depositUsd = 10000;
    const ilUsd = calculateILUsd(depositUsd, 100, 200);
    expect(ilUsd).toBeLessThan(0);
    expect(Math.abs(ilUsd)).toBeCloseTo(571.9, 0);
  });
});

describe('calculateATR', () => {
  it('should return 0 for insufficient data', () => {
    expect(calculateATR([100, 101, 102], 14)).toBe(0);
  });

  it('should calculate ATR correctly for simple data', () => {
    // Create a simple series with known movements
    const prices = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 === 0 ? 1 : -1));
    const atr = calculateATR(prices, 14);
    expect(atr).toBeGreaterThan(0);
    expect(atr).toBeCloseTo(2, 0); // Movement of ~2 each period
  });

  it('should return higher ATR for volatile data', () => {
    const stable = Array.from({ length: 20 }, (_, i) => 100 + i * 0.1);
    const volatile = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i) * 10);

    const atrStable = calculateATR(stable, 14);
    const atrVolatile = calculateATR(volatile, 14);

    expect(atrVolatile).toBeGreaterThan(atrStable);
  });
});

describe('calculateATRRatio', () => {
  it('should return 0 for insufficient data', () => {
    expect(calculateATRRatio([100], 14)).toBe(0);
  });

  it('should return a positive ratio for valid data', () => {
    const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5);
    const ratio = calculateATRRatio(prices, 14);
    expect(ratio).toBeGreaterThan(0);
  });
});

describe('calculateEMA', () => {
  it('should return NaN for empty array', () => {
    expect(calculateEMA([], 7)).toBeNaN();
  });

  it('should return average for insufficient data', () => {
    const ema = calculateEMA([10, 20, 30], 7);
    expect(ema).toBeCloseTo(20, 5);
  });

  it('should weight recent prices more heavily', () => {
    // Price rises then falls back
    const prices = [100, 101, 102, 103, 104, 105, 106, 107, 106, 105, 104, 103, 102];
    const ema7 = calculateEMA(prices, 7);
    const sma = prices.reduce((a, b) => a + b, 0) / prices.length;
    // EMA should be closer to recent (lower) values than SMA
    expect(ema7).toBeLessThan(sma);
  });

  it('EMA(7) should be more responsive than EMA(21)', () => {
    // Rising prices
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
    const ema7 = calculateEMA(prices, 7);
    const ema21 = calculateEMA(prices, 21);
    // Shorter EMA should be higher for rising prices
    expect(ema7).toBeGreaterThan(ema21);
  });
});

describe('calculateBollingerBands', () => {
  it('should throw for insufficient data', () => {
    const prices = [100, 101, 102];
    expect(() => calculateBollingerBands(prices, 20)).toThrow('Insufficient data');
  });

  it('should calculate correct bands for constant prices', () => {
    const prices = Array.from({ length: 20 }, () => 100);
    const bands = calculateBollingerBands(prices, 20, 2);
    expect(bands.middle).toBeCloseTo(100, 5);
    expect(bands.upper).toBeCloseTo(100, 5); // No std dev
    expect(bands.lower).toBeCloseTo(100, 5);
  });

  it('should have upper > middle > lower for varying prices', () => {
    const prices = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 5);
    const bands = calculateBollingerBands(prices, 20, 2);
    expect(bands.upper).toBeGreaterThan(bands.middle);
    expect(bands.middle).toBeGreaterThan(bands.lower);
  });

  it('should widen bands with higher std dev multiplier', () => {
    const prices = Array.from({ length: 25 }, (_, i) => 100 + Math.sin(i) * 5);
    const narrow = calculateBollingerBands(prices, 20, 1);
    const wide = calculateBollingerBands(prices, 20, 3);
    expect(wide.upper - wide.lower).toBeGreaterThan(narrow.upper - narrow.lower);
  });
});

describe('clamp', () => {
  it('should clamp values within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe('distanceToBoundary', () => {
  it('should return 0 when price is at boundary', () => {
    expect(distanceToBoundary(100, 100, 200)).toBe(0);
    expect(distanceToBoundary(200, 100, 200)).toBe(0);
  });

  it('should return 0 when price is outside range', () => {
    expect(distanceToBoundary(50, 100, 200)).toBe(0);
    expect(distanceToBoundary(250, 100, 200)).toBe(0);
  });

  it('should return 0.5 when price is at center', () => {
    expect(distanceToBoundary(150, 100, 200)).toBeCloseTo(0.5, 5);
  });

  it('should return small value near boundaries', () => {
    const dist = distanceToBoundary(105, 100, 200);
    expect(dist).toBeLessThan(0.1);
  });
});

describe('standardDeviation', () => {
  it('should return 0 for empty array', () => {
    expect(standardDeviation([])).toBe(0);
  });

  it('should return 0 for identical values', () => {
    expect(standardDeviation([5, 5, 5, 5])).toBe(0);
  });

  it('should calculate correct std dev', () => {
    // Known values: [2, 4, 4, 4, 5, 5, 7, 9] -> mean=5, variance=4, stddev=2
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 5);
  });
});
