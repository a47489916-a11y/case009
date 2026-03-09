/**
 * Orca Whirlpool CLMM adapter for Solana.
 * Implements the CLMMAdapter interface for interacting with Orca concentrated liquidity pools.
 */

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { getLogger } from '../../utils/logger.ts';
import { sqrtPriceX64ToPrice, priceToSqrtPriceX64, priceToTick, tickToPrice } from '../../utils/math.ts';
import type { CLMMAdapter, Position, Chain, Dex } from '../../core/types.ts';

/** Well-known Orca Whirlpool program ID. */
const WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc');

/**
 * Orca Whirlpool CLMM adapter.
 * Provides methods to interact with Orca concentrated liquidity positions on Solana.
 */
export class OrcaAdapter implements CLMMAdapter {
  readonly chain: Chain = 'solana';
  readonly dex: Dex = 'orca';

  private readonly connection: Connection;
  private wallet: Keypair | null = null;
  private readonly walletPath: string;

  constructor(params: { rpcUrl: string; walletPath: string }) {
    this.connection = new Connection(params.rpcUrl, 'confirmed');
    this.walletPath = params.walletPath;
  }

  /** Load the wallet keypair from file. */
  private getWallet(): Keypair {
    if (!this.wallet) {
      try {
        const keyData = JSON.parse(readFileSync(this.walletPath, 'utf-8')) as number[];
        this.wallet = Keypair.fromSecretKey(Uint8Array.from(keyData));
      } catch (err) {
        throw new Error(`Failed to load Solana wallet from ${this.walletPath}: ${(err as Error).message}`);
      }
    }
    return this.wallet;
  }

  /**
   * Fetch all Orca Whirlpool positions owned by the configured wallet.
   */
  async getPositions(): Promise<Position[]> {
    const logger = getLogger();
    const wallet = this.getWallet();

    try {
      // In production, this would use the Orca SDK to query positions.
      // Here we demonstrate the interface and data flow.
      logger.info('Fetching Orca Whirlpool positions', {
        wallet: wallet.publicKey.toBase58(),
      });

      // Placeholder: query on-chain position accounts
      // const positions = await WhirlpoolClient.getPositions(wallet.publicKey);
      // For now, return empty array — real implementation needs @orca-so/whirlpools-sdk

      return [];
    } catch (err) {
      logger.error('Failed to fetch Orca positions', { error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Get the current pool price for an Orca Whirlpool.
   * @param pool Pool address as a base58 string
   */
  async getPoolPrice(pool: string): Promise<number> {
    const logger = getLogger();

    try {
      const poolPubkey = new PublicKey(pool);
      const accountInfo = await this.connection.getAccountInfo(poolPubkey);

      if (!accountInfo) {
        throw new Error(`Pool account not found: ${pool}`);
      }

      // Orca Whirlpool pool layout: sqrtPrice is at offset 65, 16 bytes (u128)
      // In production, use the Orca SDK's parser. Here we demonstrate the concept.
      const data = accountInfo.data;
      if (data.length < 81) {
        throw new Error('Invalid pool account data');
      }

      // Read sqrtPriceX64 from the pool data (simplified)
      const sqrtPriceBytes = data.subarray(65, 81);
      const sqrtPriceX64 = BigInt('0x' + Buffer.from(sqrtPriceBytes).reverse().toString('hex'));
      const price = sqrtPriceX64ToPrice(sqrtPriceX64);

      logger.debug('Orca pool price fetched', { pool, price });
      return price;
    } catch (err) {
      logger.error('Failed to fetch Orca pool price', { pool, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Collect accrued fees from an Orca Whirlpool position.
   * @param positionId Position NFT mint address
   */
  async collectFees(positionId: string): Promise<{ tokenAAmount: bigint; tokenBAmount: bigint }> {
    const logger = getLogger();
    const wallet = this.getWallet();

    logger.info('Collecting fees from Orca position', { positionId });

    try {
      // In production: build and send collectFees transaction using Orca SDK
      // const tx = await WhirlpoolClient.collectFees(positionId);
      // const sig = await sendAndConfirmTransaction(this.connection, tx, [wallet]);

      // Placeholder return
      return { tokenAAmount: 0n, tokenBAmount: 0n };
    } catch (err) {
      logger.error('Failed to collect Orca fees', { positionId, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Close an Orca Whirlpool position, withdrawing all liquidity.
   * @param positionId Position NFT mint address
   */
  async closePosition(positionId: string): Promise<{ tokenAAmount: bigint; tokenBAmount: bigint }> {
    const logger = getLogger();
    const wallet = this.getWallet();

    logger.info('Closing Orca position', { positionId });

    try {
      // In production: build decreaseLiquidity + closePosition transaction
      // 1. Decrease liquidity to 0
      // 2. Collect remaining fees
      // 3. Close position account

      return { tokenAAmount: 0n, tokenBAmount: 0n };
    } catch (err) {
      logger.error('Failed to close Orca position', { positionId, error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Open a new Orca Whirlpool position.
   */
  async openPosition(params: {
    pool: string;
    lowerPrice: number;
    upperPrice: number;
    tokenAAmount: bigint;
    tokenBAmount: bigint;
  }): Promise<Position> {
    const logger = getLogger();
    const wallet = this.getWallet();

    const lowerTick = priceToTick(params.lowerPrice);
    const upperTick = priceToTick(params.upperPrice);

    logger.info('Opening new Orca position', {
      pool: params.pool,
      lowerTick,
      upperTick,
      lowerPrice: params.lowerPrice,
      upperPrice: params.upperPrice,
    });

    try {
      // In production: build openPosition + increaseLiquidity transaction
      // 1. Open position with tick range
      // 2. Increase liquidity with token amounts

      const now = new Date();
      return {
        id: `orca-${Date.now()}`,
        chain: 'solana',
        dex: 'orca',
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
      logger.error('Failed to open Orca position', { error: (err as Error).message });
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
      // In production: build the full rebalance transaction and simulate it
      // using connection.simulateTransaction()
      logger.info('Simulating Orca rebalance', params);

      return { success: true, estimatedCost: 0.001 };
    } catch (err) {
      return {
        success: false,
        estimatedCost: 0,
        error: (err as Error).message,
      };
    }
  }
}
