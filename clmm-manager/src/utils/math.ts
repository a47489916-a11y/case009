/**
 * Math utilities for CLMM operations.
 * Includes tick/price conversions, IL calculation, ATR, EMA, Bollinger Bands.
 */

// ---------- Constants ----------

/** Tick spacing factor used by Orca Whirlpools. */
const TICK_BASE = 1.0001;

/** Q64 fixed-point multiplier used in sqrtPriceX64 format. */
const Q64 = BigInt(1) << BigInt(64);

// ---------- Tick / Price Conversions ----------

/**
 * Convert a tick index to a price.
 * price = 1.0001 ^ tick
 * @param tick The tick index
 * @returns The corresponding price
 */
export function tickToPrice(tick: number): number {
  return Math.pow(TICK_BASE, tick);
}

/**
 * Convert a price to the nearest tick index.
 * tick = log(price) / log(1.0001)
 * @param price The price
 * @returns The corresponding tick index (floored to integer)
 */
export function priceToTick(price: number): number {
  if (price <= 0) throw new Error('Price must be positive');
  return Math.floor(Math.log(price) / Math.log(TICK_BASE));
}

/**
 * Convert a sqrtPriceX64 value (Orca Whirlpool format) to a human-readable price.
 * price = (sqrtPriceX64 / 2^64)^2
 * @param sqrtPriceX64 The sqrtPriceX64 bigint value
 * @returns The price as a number
 */
export function sqrtPriceX64ToPrice(sqrtPriceX64: bigint): number {
  const sqrtPrice = Number(sqrtPriceX64) / Number(Q64);
  return sqrtPrice * sqrtPrice;
}

/**
 * Convert a price to sqrtPriceX64 format (Orca Whirlpool format).
 * sqrtPriceX64 = sqrt(price) * 2^64
 * @param price The price as a number
 * @returns The sqrtPriceX64 bigint value
 */
export function priceToSqrtPriceX64(price: number): bigint {
  if (price < 0) throw new Error('Price must be non-negative');
  const sqrtPrice = Math.sqrt(price);
  return BigInt(Math.floor(sqrtPrice * Number(Q64)));
}

/**
 * Convert a percentage range to a tick range around a current price.
 * @param currentPrice The current market price
 * @param pctLower Lower bound percentage (e.g., 0.10 for -10%)
 * @param pctUpper Upper bound percentage (e.g., 0.10 for +10%)
 * @param tickSpacing The pool's tick spacing
 * @returns Object with lower and upper tick indices, snapped to tick spacing
 */
export function pctRangeToTicks(
  currentPrice: number,
  pctLower: number,
  pctUpper: number,
  tickSpacing: number
): { lowerTick: number; upperTick: number } {
  const lowerPrice = currentPrice * (1 - pctLower);
  const upperPrice = currentPrice * (1 + pctUpper);

  let lowerTick = priceToTick(lowerPrice);
  let upperTick = priceToTick(upperPrice);

  // Snap to tick spacing
  lowerTick = Math.floor(lowerTick / tickSpacing) * tickSpacing;
  upperTick = Math.ceil(upperTick / tickSpacing) * tickSpacing;

  return { lowerTick, upperTick };
}

/**
 * Validate that a tick range respects the minimum width (tickSpacing * 2).
 * @param lowerTick Lower tick index
 * @param upperTick Upper tick index
 * @param tickSpacing The pool's tick spacing
 * @returns true if the range is valid
 */
export function isValidTickRange(lowerTick: number, upperTick: number, tickSpacing: number): boolean {
  return (upperTick - lowerTick) >= tickSpacing * 2;
}

// ---------- Impermanent Loss ----------

/**
 * Calculate impermanent loss for a concentrated liquidity position.
 * Uses the standard IL formula: IL = 2*sqrt(r)/(1+r) - 1 where r = priceNow/priceEntry
 * @param priceEntry The price when the position was opened
 * @param priceNow The current price
 * @returns The IL as a negative fraction (e.g., -0.05 means 5% loss)
 */
export function calculateIL(priceEntry: number, priceNow: number): number {
  if (priceEntry <= 0 || priceNow <= 0) throw new Error('Prices must be positive');
  const r = priceNow / priceEntry;
  const il = (2 * Math.sqrt(r)) / (1 + r) - 1;
  return il;
}

/**
 * Calculate impermanent loss in USD.
 * @param depositValueUsd The initial deposit value in USD
 * @param priceEntry The entry price ratio
 * @param priceNow The current price ratio
 * @returns The IL in USD (negative value)
 */
export function calculateILUsd(depositValueUsd: number, priceEntry: number, priceNow: number): number {
  const ilPct = calculateIL(priceEntry, priceNow);
  return depositValueUsd * ilPct;
}

// ---------- ATR (Average True Range) ----------

/**
 * Calculate Average True Range from price data.
 * Uses simplified ATR based on high-low of consecutive periods.
 * @param prices Array of closing prices (most recent last)
 * @param period ATR period (default 14)
 * @returns ATR value, or 0 if insufficient data
 */
export function calculateATR(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 0;

  const trueRanges: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]!;
    const curr = prices[i]!;
    // Simplified: true range = |current - previous|
    const tr = Math.abs(curr - prev);
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return 0;

  // Use the last `period` true ranges
  const recentTRs = trueRanges.slice(-period);
  const sum = recentTRs.reduce((a, b) => a + b, 0);
  return sum / period;
}

/**
 * Calculate ATR as a ratio of the current price for normalization.
 * @param prices Array of closing prices
 * @param period ATR period
 * @returns ATR ratio (ATR / last price)
 */
export function calculateATRRatio(prices: number[], period = 14): number {
  const atr = calculateATR(prices, period);
  const lastPrice = prices[prices.length - 1];
  if (!lastPrice || lastPrice === 0) return 0;
  return atr / lastPrice;
}

// ---------- EMA (Exponential Moving Average) ----------

/**
 * Calculate Exponential Moving Average.
 * @param prices Array of prices (most recent last)
 * @param period EMA period
 * @returns The EMA value, or NaN if insufficient data
 */
export function calculateEMA(prices: number[], period: number): number {
  if (prices.length === 0 || period <= 0) return NaN;
  if (prices.length < period) {
    // Not enough data; return simple average
    return prices.reduce((a, b) => a + b, 0) / prices.length;
  }

  const multiplier = 2 / (period + 1);

  // SMA of the first `period` values as the initial EMA
  let ema = 0;
  for (let i = 0; i < period; i++) {
    ema += prices[i]!;
  }
  ema /= period;

  // Apply EMA formula for remaining values
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i]! - ema) * multiplier + ema;
  }

  return ema;
}

// ---------- Bollinger Bands ----------

/**
 * Calculate Bollinger Bands.
 * @param prices Array of prices (most recent last)
 * @param period Period for SMA (default 20)
 * @param numStdDev Number of standard deviations (default 2)
 * @returns Object with upper, middle (SMA), and lower band values
 */
export function calculateBollingerBands(
  prices: number[],
  period = 20,
  numStdDev = 2
): { upper: number; middle: number; lower: number } {
  if (prices.length < period) {
    throw new Error(`Insufficient data: need ${period} prices, got ${prices.length}`);
  }

  const recentPrices = prices.slice(-period);
  const mean = recentPrices.reduce((a, b) => a + b, 0) / period;

  const variance = recentPrices.reduce((sum, p) => sum + (p - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: mean + numStdDev * stdDev,
    middle: mean,
    lower: mean - numStdDev * stdDev,
  };
}

// ---------- Utility ----------

/**
 * Clamp a value between min and max.
 * @param value The value to clamp
 * @param min Minimum bound
 * @param max Maximum bound
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Calculate the percentage distance from a current price to the nearest range boundary.
 * Returns the minimum of (distance to lower, distance to upper) as a fraction.
 * @param currentPrice Current market price
 * @param lowerPrice Lower range bound
 * @param upperPrice Upper range bound
 * @returns Fraction representing distance to nearest boundary (0 = at boundary, 1 = at center)
 */
export function distanceToBoundary(currentPrice: number, lowerPrice: number, upperPrice: number): number {
  if (currentPrice <= lowerPrice || currentPrice >= upperPrice) return 0;
  const rangeWidth = upperPrice - lowerPrice;
  const distToLower = (currentPrice - lowerPrice) / rangeWidth;
  const distToUpper = (upperPrice - currentPrice) / rangeWidth;
  return Math.min(distToLower, distToUpper);
}

/**
 * Calculate standard deviation of an array of numbers.
 * @param values Array of numbers
 * @returns Standard deviation
 */
export function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
