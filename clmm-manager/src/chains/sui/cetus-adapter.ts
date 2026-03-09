/**
 * Cetus CLMM adapter for SUI.
 * Implements the CLMMAdapter interface for interacting with Cetus concentrated liquidity pools.
 */

import { getLogger } from '../../utils/logger.ts';
import { priceToTick } from '../../utils/math.ts';
import type { CLMMAdapter, Position, Chain, Dex } from '../../core/types.ts';

/**
 * Cetus CLMM adapter for SUI blockchain.
 * Provides methods to interact with Cetus concentrated liquidity positions.
 */
export class CetusAdapter implements CLMMAdapter {
  readonly chain: Chain = 'sui';
  readonly dex: Dex = 'cetus';

  private readonly rpcUrl: string;
  private readonly walletPath: string;

  constructor(params: { rpcUrl: string; walletPath: string }) {
    this.rpcUrl = params.rpcUrl;
    this.walletPath = params.walletPath;
  }

  /**
   * Make an RPC call to the SUI fullnode.
   */
  private async suiRpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`SUI RPC error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (data.error) {
      throw new Error(`SUI RPC error: ${data.error.message}`);
    }

    return data.result;
  }

  /**
   * Fetch all Cetus CLMM positions owned by the configured wallet.
   */
  async getPositions(): Promise<Position[]> {
    const logger = getLogger();

    try {
      logger.info('Fetching Cetus CLMM positions');

      // In production, query SUI for owned objects filtered by Cetus position type
      // const objects = await this.suiRpc('suix_getOwnedObjects', [walletAddress, { filter: ... }]);

      return [];
    } catch (err) {
      logger.error('Failed to fetch Cetus positions', { error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Get the current pool price for a Cetus CLMM pool.
   * @param pool Pool object ID on SUI
   */
  async getPoolPrice(pool: string): Promise<number> {
    const logger = getLogger();

    try {
      // Fetch the pool object to read its current sqrt_price
      const result = (await this.suiRpc('sui_getObject', [
        pool,
        { showContent: true },
      ])) as {
        data?: {
          content?: {
            fields?: {
              current_sqrt_price?: string;
            };
          };
        };
      };

      const sqrtPrice = result?.data?.content?.fields?.current_sqrt_price;
      if (!sqrtPrice) {
        throw new Error(`Could not read sqrt_price from Cetus pool: ${pool}`);
      }

      // Cetus uses a similar sqrtPrice encoding; convert to human-readable price
      const sqrtPriceNum = Number(sqrtPrice) / (2 ** 64);
      const price = sqrtPriceNum * sqrtPriceNum;

      logger.debug('Cetus pool price fetched', { pool, price });
      return price;
    } catch (err) {
      logger.error('Failed to fetch Cetus pool price', { pool, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Collect accrued fees from a Cetus position.
   * @param positionId Position object ID on SUI
   */
  async collectFees(positionId: string): Promise<{ tokenAAmount: bigint; tokenBAmount: bigint }> {
    const logger = getLogger();
    logger.info('Collecting fees from Cetus position', { positionId });

    try {
      // In production: build a Move call transaction to collect_fee on the Cetus pool module
      // const tx = new TransactionBlock();
      // tx.moveCall({ target: `${CETUS_PACKAGE}::pool::collect_fee`, arguments: [...] });

      return { tokenAAmount: 0n, tokenBAmount: 0n };
    } catch (err) {
      logger.error('Failed to collect Cetus fees', { positionId, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Close a Cetus position, withdrawing all liquidity.
   */
  async closePosition(positionId: string): Promise<{ tokenAAmount: bigint; tokenBAmount: bigint }> {
    const logger = getLogger();
    logger.info('Closing Cetus position', { positionId });

    try {
      // In production:
      // 1. Remove all liquidity via remove_liquidity
      // 2. Collect remaining fees
      // 3. Close position NFT

      return { tokenAAmount: 0n, tokenBAmount: 0n };
    } catch (err) {
      logger.error('Failed to close Cetus position', { positionId, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Open a new Cetus CLMM position.
   */
  async openPosition(params: {
    pool: string;
    lowerPrice: number;
    upperPrice: number;
    tokenAAmount: bigint;
    tokenBAmount: bigint;
  }): Promise<Position> {
    const logger = getLogger();

    const lowerTick = priceToTick(params.lowerPrice);
    const upperTick = priceToTick(params.upperPrice);

    logger.info('Opening new Cetus position', {
      pool: params.pool,
      lowerTick,
      upperTick,
    });

    try {
      // In production: build Move call transaction for open_position + add_liquidity
      const now = new Date();
      return {
        id: `cetus-${Date.now()}`,
        chain: 'sui',
        dex: 'cetus',
        pool: params.pool,
        tokenA: '',
        tokenB: '',
        lowerPrice: params.lowerPrice,
        upperPrice: params.upperPrice,
        liquidity: 0n,
        depositedValueUsd: 0,
        currentValueUsd: 0,
        feesEarnedUsd: 0,
        openedAt: now,
        lastRebalanceAt: now,
      };
    } catch (err) {
      logger.error('Failed to open Cetus position', { error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Simulate a rebalance transaction before execution.
   */
  async simulateRebalance(params: {
    positionId: string;
    newLowerPrice: number;
    newUpperPrice: number;
  }): Promise<{ success: boolean; estimatedCost: number; error?: string }> {
    const logger = getLogger();

    try {
      logger.info('Simulating Cetus rebalance', params);

      // In production: use sui_dryRunTransactionBlock to simulate
      return { success: true, estimatedCost: 0.01 };
    } catch (err) {
      return {
        success: false,
        estimatedCost: 0,
        error: (err as Error).message,
      };
    }
  }
}
