/**
 * Cryptact CSV exporter for Japanese tax reporting.
 * Generates Cryptact-compatible CSV from LP operations.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../utils/logger.ts';
import type { CryptactRow, Position, RebalanceAction } from '../core/types.ts';

/** JPY conversion rate cache. */
interface RateCache {
  rate: number;
  timestamp: number;
}

/**
 * Cryptact CSV exporter for tax reporting.
 */
export class CryptactExporter {
  private readonly outputDir: string;
  private readonly baseCurrency: string;
  private readonly rows: CryptactRow[] = [];
  private jpyRateCache: RateCache | null = null;

  constructor(params: { outputDir: string; baseCurrency?: string }) {
    this.outputDir = params.outputDir;
    this.baseCurrency = params.baseCurrency ?? 'JPY';

    if (!existsSync(this.outputDir)) {
      mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Fetch USD/JPY conversion rate from a public API.
   * Caches for 1 hour.
   */
  async getJPYRate(): Promise<number> {
    if (this.jpyRateCache && Date.now() - this.jpyRateCache.timestamp < 3600_000) {
      return this.jpyRateCache.rate;
    }

    const logger = getLogger();

    try {
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=usd&vs_currencies=jpy',
        { signal: AbortSignal.timeout(10_000) }
      );

      if (response.ok) {
        const data = (await response.json()) as { usd?: { jpy?: number } };
        const rate = data.usd?.jpy ?? 150;
        this.jpyRateCache = { rate, timestamp: Date.now() };
        return rate;
      }
    } catch (err) {
      logger.warn('Failed to fetch JPY rate, using fallback', { error: (err as Error).message });
    }

    // Fallback rate
    return 150;
  }

  /**
   * Record an LP deposit as a LOSS-type entry (sending tokens to LP).
   * @param position The position being opened
   * @param tokenAAmount Amount of token A deposited
   * @param tokenBAmount Amount of token B deposited
   * @param tokenAPrice Price of token A in USD
   * @param tokenBPrice Price of token B in USD
   */
  async recordDeposit(
    position: Position,
    tokenAAmount: number,
    tokenBAmount: number,
    tokenAPrice: number,
    tokenBPrice: number
  ): Promise<void> {
    const jpyRate = this.baseCurrency === 'JPY' ? await this.getJPYRate() : 1;

    // Token A deposit → LOSS
    if (tokenAAmount > 0) {
      this.rows.push({
        Timestamp: this.formatTimestamp(position.openedAt),
        Action: 'LOSS',
        Source: `${position.dex}-${position.pool}`,
        Base: position.tokenA,
        Volume: tokenAAmount.toFixed(8),
        Price: (tokenAPrice * jpyRate).toFixed(2),
        Counter: this.baseCurrency,
        Fee: '0',
        FeeCcy: this.baseCurrency,
        Comment: `LP deposit to ${position.pool} position ${position.id}`,
      });
    }

    // Token B deposit → LOSS
    if (tokenBAmount > 0) {
      this.rows.push({
        Timestamp: this.formatTimestamp(position.openedAt),
        Action: 'LOSS',
        Source: `${position.dex}-${position.pool}`,
        Base: position.tokenB,
        Volume: tokenBAmount.toFixed(8),
        Price: (tokenBPrice * jpyRate).toFixed(2),
        Counter: this.baseCurrency,
        Fee: '0',
        FeeCcy: this.baseCurrency,
        Comment: `LP deposit to ${position.pool} position ${position.id}`,
      });
    }
  }

  /**
   * Record an LP withdrawal as a BONUS-type entry (receiving tokens from LP).
   * @param position The position being closed
   * @param tokenAAmount Amount of token A received
   * @param tokenBAmount Amount of token B received
   * @param tokenAPrice Price of token A in USD
   * @param tokenBPrice Price of token B in USD
   */
  async recordWithdrawal(
    position: Position,
    tokenAAmount: number,
    tokenBAmount: number,
    tokenAPrice: number,
    tokenBPrice: number
  ): Promise<void> {
    const jpyRate = this.baseCurrency === 'JPY' ? await this.getJPYRate() : 1;

    // Token A withdrawal → BONUS
    if (tokenAAmount > 0) {
      this.rows.push({
        Timestamp: this.formatTimestamp(new Date()),
        Action: 'BONUS',
        Source: `${position.dex}-${position.pool}`,
        Base: position.tokenA,
        Volume: tokenAAmount.toFixed(8),
        Price: (tokenAPrice * jpyRate).toFixed(2),
        Counter: this.baseCurrency,
        Fee: '0',
        FeeCcy: this.baseCurrency,
        Comment: `LP withdrawal from ${position.pool} position ${position.id}`,
      });
    }

    // Token B withdrawal → BONUS
    if (tokenBAmount > 0) {
      this.rows.push({
        Timestamp: this.formatTimestamp(new Date()),
        Action: 'BONUS',
        Source: `${position.dex}-${position.pool}`,
        Base: position.tokenB,
        Volume: tokenBAmount.toFixed(8),
        Price: (tokenBPrice * jpyRate).toFixed(2),
        Counter: this.baseCurrency,
        Fee: '0',
        FeeCcy: this.baseCurrency,
        Comment: `LP withdrawal from ${position.pool} position ${position.id}`,
      });
    }
  }

  /**
   * Record a token swap as paired SELL and BUY entries.
   * @param timestamp When the swap occurred
   * @param source DEX source identifier
   * @param sellToken Token being sold
   * @param sellAmount Amount sold
   * @param sellPrice Price of sell token in base currency
   * @param buyToken Token being bought
   * @param buyAmount Amount bought
   * @param buyPrice Price of buy token in base currency
   * @param feeAmount Fee amount
   * @param feeCurrency Fee currency
   */
  async recordSwap(params: {
    timestamp: Date;
    source: string;
    sellToken: string;
    sellAmount: number;
    sellPrice: number;
    buyToken: string;
    buyAmount: number;
    buyPrice: number;
    feeAmount: number;
    feeCurrency: string;
  }): Promise<void> {
    const jpyRate = this.baseCurrency === 'JPY' ? await this.getJPYRate() : 1;

    // SELL entry
    this.rows.push({
      Timestamp: this.formatTimestamp(params.timestamp),
      Action: 'SELL',
      Source: params.source,
      Base: params.sellToken,
      Volume: params.sellAmount.toFixed(8),
      Price: (params.sellPrice * jpyRate).toFixed(2),
      Counter: this.baseCurrency,
      Fee: (params.feeAmount * jpyRate).toFixed(2),
      FeeCcy: this.baseCurrency,
      Comment: `Swap ${params.sellToken} for ${params.buyToken}`,
    });

    // BUY entry
    this.rows.push({
      Timestamp: this.formatTimestamp(params.timestamp),
      Action: 'BUY',
      Source: params.source,
      Base: params.buyToken,
      Volume: params.buyAmount.toFixed(8),
      Price: (params.buyPrice * jpyRate).toFixed(2),
      Counter: this.baseCurrency,
      Fee: '0',
      FeeCcy: this.baseCurrency,
      Comment: `Swap ${params.sellToken} for ${params.buyToken}`,
    });
  }

  /**
   * Export all collected rows to a CSV file.
   * @param filename Optional filename (defaults to cryptact_YYYY.csv)
   * @returns The full path to the written CSV file
   */
  exportCSV(filename?: string): string {
    const logger = getLogger();
    const year = new Date().getFullYear();
    const fname = filename ?? `cryptact_${year}.csv`;
    const fullPath = join(this.outputDir, fname);

    const header = 'Timestamp,Action,Source,Base,Volume,Price,Counter,Fee,FeeCcy,Comment';
    const lines = this.rows.map((row) =>
      [
        row.Timestamp,
        row.Action,
        row.Source,
        row.Base,
        row.Volume,
        row.Price,
        row.Counter,
        row.Fee,
        row.FeeCcy,
        `"${row.Comment}"`,
      ].join(',')
    );

    const csv = [header, ...lines].join('\n') + '\n';
    writeFileSync(fullPath, csv, 'utf-8');

    logger.info('Cryptact CSV exported', { path: fullPath, rows: this.rows.length });
    return fullPath;
  }

  /** Get the number of pending rows. */
  getRowCount(): number {
    return this.rows.length;
  }

  /** Clear all pending rows. */
  clearRows(): void {
    this.rows.length = 0;
  }

  /** Format a Date to Cryptact timestamp format: YYYY/MM/DD HH:mm:ss */
  private formatTimestamp(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    const h = String(date.getUTCHours()).padStart(2, '0');
    const min = String(date.getUTCMinutes()).padStart(2, '0');
    const s = String(date.getUTCSeconds()).padStart(2, '0');
    return `${y}/${m}/${d} ${h}:${min}:${s}`;
  }
}
