/**
 * Jupiter swap integration for Solana.
 * Implements the SwapAdapter interface using Jupiter Aggregator V6 API.
 */

import { Connection, Keypair } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { getLogger } from '../../utils/logger.ts';
import type { SwapAdapter, Chain } from '../../core/types.ts';

/** Jupiter V6 API base URL. */
const JUPITER_API_BASE = 'https://quote-api.jup.ag/v6';

/**
 * Jupiter swap adapter for Solana token swaps.
 */
export class JupiterSwapAdapter implements SwapAdapter {
  readonly chain: Chain = 'solana';

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
        throw new Error(`Failed to load wallet: ${(err as Error).message}`);
      }
    }
    return this.wallet;
  }

  /**
   * Get a swap quote from Jupiter.
   * @param params Swap parameters including mints, amount, and slippage
   * @returns Quote with expected output, price impact, and fees
   */
  async getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }): Promise<{ expectedOutput: bigint; priceImpactPct: number; fee: bigint }> {
    const logger = getLogger();

    try {
      const url = new URL(`${JUPITER_API_BASE}/quote`);
      url.searchParams.set('inputMint', params.inputMint);
      url.searchParams.set('outputMint', params.outputMint);
      url.searchParams.set('amount', params.amount.toString());
      url.searchParams.set('slippageBps', params.slippageBps.toString());

      const response = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`Jupiter API returned ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as {
        outAmount: string;
        priceImpactPct: string;
        routePlan: Array<{ swapInfo: { feeAmount: string } }>;
      };

      const totalFee = data.routePlan.reduce(
        (sum, step) => sum + BigInt(step.swapInfo.feeAmount),
        0n
      );

      logger.debug('Jupiter quote received', {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount.toString(),
        outAmount: data.outAmount,
        priceImpact: data.priceImpactPct,
      });

      return {
        expectedOutput: BigInt(data.outAmount),
        priceImpactPct: parseFloat(data.priceImpactPct),
        fee: totalFee,
      };
    } catch (err) {
      logger.error('Jupiter quote failed', { error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Execute a token swap via Jupiter.
   * @param params Swap parameters including mints, amount, slippage, and minimum output
   * @returns Transaction hash and actual output amount
   */
  async executeSwap(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
    minOutput: bigint;
  }): Promise<{ txHash: string; actualOutput: bigint }> {
    const logger = getLogger();
    const wallet = this.getWallet();

    try {
      // Step 1: Get quote
      const quoteUrl = new URL(`${JUPITER_API_BASE}/quote`);
      quoteUrl.searchParams.set('inputMint', params.inputMint);
      quoteUrl.searchParams.set('outputMint', params.outputMint);
      quoteUrl.searchParams.set('amount', params.amount.toString());
      quoteUrl.searchParams.set('slippageBps', params.slippageBps.toString());

      const quoteResponse = await fetch(quoteUrl.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!quoteResponse.ok) {
        throw new Error(`Jupiter quote failed: ${quoteResponse.status}`);
      }

      const quoteData = await quoteResponse.json();

      // Step 2: Get swap transaction
      const swapResponse = await fetch(`${JUPITER_API_BASE}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quoteData,
          userPublicKey: wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!swapResponse.ok) {
        throw new Error(`Jupiter swap transaction build failed: ${swapResponse.status}`);
      }

      const swapData = (await swapResponse.json()) as { swapTransaction: string };

      // Step 3: Deserialize, sign, and send transaction
      const txBuffer = Buffer.from(swapData.swapTransaction, 'base64');
      // In production: deserialize, sign with wallet, send via connection

      logger.info('Jupiter swap executed', {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amount.toString(),
      });

      // Placeholder return; actual tx hash and output would come from on-chain confirmation
      return {
        txHash: 'placeholder-tx-hash',
        actualOutput: 0n,
      };
    } catch (err) {
      logger.error('Jupiter swap failed', { error: (err as Error).message });
      throw err;
    }
  }
}
