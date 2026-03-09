/**
 * SUI DEX swap adapter.
 * Implements the SwapAdapter interface for token swaps on the SUI blockchain.
 * Supports Cetus aggregator and other SUI DEX protocols.
 */

import { getLogger } from '../../utils/logger.ts';
import type { SwapAdapter, Chain } from '../../core/types.ts';

/** Cetus aggregator API base URL. */
const CETUS_AGGREGATOR_API = 'https://api-sui.cetus.zone/router_v2/find_routes';

/**
 * SUI DEX swap adapter using Cetus aggregator.
 */
export class SuiSwapAdapter implements SwapAdapter {
  readonly chain: Chain = 'sui';

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
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`SUI RPC error: ${response.status}`);
    }

    const data = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (data.error) {
      throw new Error(`SUI RPC error: ${data.error.message}`);
    }

    return data.result;
  }

  /**
   * Get a swap quote from the Cetus aggregator.
   */
  async getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }): Promise<{ expectedOutput: bigint; priceImpactPct: number; fee: bigint }> {
    const logger = getLogger();

    try {
      const url = new URL(CETUS_AGGREGATOR_API);
      url.searchParams.set('from', params.inputMint);
      url.searchParams.set('target', params.outputMint);
      url.searchParams.set('amount', params.amount.toString());
      url.searchParams.set('by_amount_in', 'true');

      const response = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`Cetus aggregator returned ${response.status}`);
      }

      const data = (await response.json()) as {
        data?: {
          routes?: Array<{
            amount_out: string;
            price_impact: string;
            fee_amount: string;
          }>;
        };
      };

      const bestRoute = data.data?.routes?.[0];
      if (!bestRoute) {
        throw new Error('No routes found for swap');
      }

      logger.debug('SUI swap quote received', {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount.toString(),
        outAmount: bestRoute.amount_out,
      });

      return {
        expectedOutput: BigInt(bestRoute.amount_out),
        priceImpactPct: parseFloat(bestRoute.price_impact || '0'),
        fee: BigInt(bestRoute.fee_amount || '0'),
      };
    } catch (err) {
      logger.error('SUI swap quote failed', { error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Execute a token swap on SUI via Cetus aggregator.
   */
  async executeSwap(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
    minOutput: bigint;
  }): Promise<{ txHash: string; actualOutput: bigint }> {
    const logger = getLogger();

    try {
      // In production:
      // 1. Get route from Cetus aggregator
      // 2. Build a TransactionBlock with the swap Move calls
      // 3. Sign and execute the transaction

      logger.info('Executing SUI swap', {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount.toString(),
      });

      // Placeholder return
      return {
        txHash: 'placeholder-sui-tx-hash',
        actualOutput: 0n,
      };
    } catch (err) {
      logger.error('SUI swap execution failed', { error: (err as Error).message });
      throw err;
    }
  }
}
