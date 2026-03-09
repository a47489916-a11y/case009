/**
 * Price oracle with Pyth as primary and CoinGecko as fallback.
 * Implements caching with configurable TTL.
 */

import { getLogger } from './logger.ts';
import type { PriceData } from '../core/types.ts';

/** Known Pyth price feed IDs for supported tokens. */
const PYTH_FEED_IDS: Record<string, string> = {
  SOL: '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  SUI: '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
  mSOL: '0xc2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4',
  USDC: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
};

/** CoinGecko token ID mapping. */
const COINGECKO_IDS: Record<string, string> = {
  SOL: 'solana',
  SUI: 'sui',
  mSOL: 'msol',
  USDC: 'usd-coin',
};

interface CacheEntry {
  data: PriceData;
  expiresAt: number;
}

/**
 * Price feed service with Pyth oracle (primary) and CoinGecko (fallback).
 */
export class PriceFeed {
  private cache = new Map<string, CacheEntry>();
  private readonly pythEndpoint: string;
  private readonly coingeckoApiKey: string;
  private readonly cacheTtlMs: number;

  constructor(params: {
    pythEndpoint: string;
    coingeckoApiKey?: string;
    cacheTtlMs?: number;
  }) {
    this.pythEndpoint = params.pythEndpoint;
    this.coingeckoApiKey = params.coingeckoApiKey ?? '';
    this.cacheTtlMs = params.cacheTtlMs ?? 30_000;
  }

  /**
   * Get the current price for a token symbol.
   * Uses cache if fresh, otherwise fetches from Pyth, then falls back to CoinGecko.
   * @param symbol Token symbol (e.g., 'SOL', 'SUI', 'mSOL')
   * @returns PriceData for the token
   */
  async getPrice(symbol: string): Promise<PriceData> {
    const logger = getLogger();
    const upperSymbol = symbol.toUpperCase();

    // Check cache
    const cached = this.cache.get(upperSymbol);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    // USDC is always ~$1
    if (upperSymbol === 'USDC') {
      const usdcData: PriceData = {
        symbol: 'USDC',
        price: 1.0,
        confidence: 0.001,
        timestamp: new Date(),
        source: 'pyth',
      };
      this.cachePrice(upperSymbol, usdcData);
      return usdcData;
    }

    // Try Pyth first
    try {
      const data = await this.fetchPyth(upperSymbol);
      this.cachePrice(upperSymbol, data);
      return data;
    } catch (err) {
      logger.warn(`Pyth fetch failed for ${upperSymbol}, falling back to CoinGecko`, {
        error: (err as Error).message,
      });
    }

    // Fallback to CoinGecko
    try {
      const data = await this.fetchCoinGecko(upperSymbol);
      this.cachePrice(upperSymbol, data);
      return data;
    } catch (err) {
      logger.error(`CoinGecko fetch also failed for ${upperSymbol}`, {
        error: (err as Error).message,
      });
      throw new Error(`Unable to fetch price for ${upperSymbol} from any source`);
    }
  }

  /**
   * Get prices for multiple tokens at once.
   * @param symbols Array of token symbols
   * @returns Map of symbol to PriceData
   */
  async getPrices(symbols: string[]): Promise<Map<string, PriceData>> {
    const results = new Map<string, PriceData>();
    const promises = symbols.map(async (symbol) => {
      try {
        const data = await this.getPrice(symbol);
        results.set(symbol.toUpperCase(), data);
      } catch {
        // Skip failed prices; caller must handle missing entries
      }
    });
    await Promise.all(promises);
    return results;
  }

  /** Fetch price from Pyth Hermes API. */
  private async fetchPyth(symbol: string): Promise<PriceData> {
    const feedId = PYTH_FEED_IDS[symbol];
    if (!feedId) {
      throw new Error(`No Pyth feed ID for symbol: ${symbol}`);
    }

    const url = `${this.pythEndpoint}/api/latest_price_feeds?ids[]=${feedId}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Pyth API returned ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as Array<{
      price: { price: string; expo: number; conf: string };
      id: string;
    }>;

    const feed = data[0];
    if (!feed) {
      throw new Error(`No price data returned for ${symbol}`);
    }

    const price = Number(feed.price.price) * Math.pow(10, feed.price.expo);
    const confidence = Number(feed.price.conf) * Math.pow(10, feed.price.expo);

    return {
      symbol,
      price,
      confidence,
      timestamp: new Date(),
      source: 'pyth',
    };
  }

  /** Fetch price from CoinGecko API. */
  private async fetchCoinGecko(symbol: string): Promise<PriceData> {
    const coinId = COINGECKO_IDS[symbol];
    if (!coinId) {
      throw new Error(`No CoinGecko ID for symbol: ${symbol}`);
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.coingeckoApiKey) {
      headers['x-cg-pro-api-key'] = this.coingeckoApiKey;
    }

    const baseUrl = this.coingeckoApiKey
      ? 'https://pro-api.coingecko.com'
      : 'https://api.coingecko.com';

    const url = `${baseUrl}/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`;
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`CoinGecko API returned ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as Record<string, { usd: number; usd_24h_change?: number }>;
    const tokenData = data[coinId];
    if (!tokenData) {
      throw new Error(`No price data returned for ${symbol} (${coinId})`);
    }

    return {
      symbol,
      price: tokenData.usd,
      confidence: 0, // CoinGecko doesn't provide confidence intervals
      timestamp: new Date(),
      source: 'coingecko',
    };
  }

  /** Store price data in cache. */
  private cachePrice(symbol: string, data: PriceData): void {
    this.cache.set(symbol, {
      data,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }

  /** Clear the price cache. */
  clearCache(): void {
    this.cache.clear();
  }
}
