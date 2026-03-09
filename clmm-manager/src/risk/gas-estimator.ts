/**
 * Transaction cost estimation for Solana and SUI chains.
 */

import { getLogger } from '../utils/logger.ts';
import type { Chain, GasEstimate } from '../core/types.ts';

/** Average Solana transaction sizes for CLMM operations. */
const SOLANA_ESTIMATES = {
  /** Base fee per signature (lamports). */
  baseFeePerSignature: 5000n,
  /** Typical number of signatures for a CLMM rebalance. */
  signaturesPerRebalance: 3,
  /** Priority fee per compute unit (micro-lamports). */
  priorityFeePerCU: 50000n,
  /** Estimated compute units for a rebalance. */
  computeUnitsPerRebalance: 400_000n,
};

/** Average SUI transaction sizes for CLMM operations. */
const SUI_ESTIMATES = {
  /** Base computation cost (MIST). */
  baseComputationCost: 1_000_000n,
  /** Storage cost per byte (MIST). */
  storageCostPerByte: 76n,
  /** Estimated bytes for a CLMM rebalance. */
  bytesPerRebalance: 2000,
  /** Storage rebate typically returned (MIST). */
  storageRebate: 500_000n,
};

/**
 * Gas and transaction cost estimator for CLMM operations.
 */
export class GasEstimator {
  private solPriceUsd: number = 0;
  private suiPriceUsd: number = 0;

  /**
   * Update the cached token prices used for USD conversion.
   * @param solPriceUsd Current SOL price in USD
   * @param suiPriceUsd Current SUI price in USD
   */
  updatePrices(solPriceUsd: number, suiPriceUsd: number): void {
    this.solPriceUsd = solPriceUsd;
    this.suiPriceUsd = suiPriceUsd;
  }

  /**
   * Estimate transaction cost for a rebalance operation.
   * @param chain The target blockchain
   * @returns Gas estimate with USD conversion
   */
  estimateRebalanceCost(chain: Chain): GasEstimate {
    const logger = getLogger();

    if (chain === 'solana') {
      return this.estimateSolanaCost();
    } else if (chain === 'sui') {
      return this.estimateSuiCost();
    }

    logger.error(`Unknown chain: ${chain}`);
    return {
      chain,
      baseFee: 0,
      priorityFee: 0,
      totalLamportsOrMist: 0n,
      totalUsd: 0,
    };
  }

  /**
   * Estimate the total cost of a full rebalance cycle on Solana:
   * collect fees + close position + swap + open position
   */
  private estimateSolanaCost(): GasEstimate {
    const baseFee = SOLANA_ESTIMATES.baseFeePerSignature * BigInt(SOLANA_ESTIMATES.signaturesPerRebalance);
    const priorityFee = (SOLANA_ESTIMATES.priorityFeePerCU * SOLANA_ESTIMATES.computeUnitsPerRebalance) / 1_000_000n;
    const totalLamports = baseFee + priorityFee;

    // Convert lamports to SOL then to USD
    const totalSol = Number(totalLamports) / 1e9;
    const totalUsd = totalSol * this.solPriceUsd;

    return {
      chain: 'solana',
      baseFee: Number(baseFee),
      priorityFee: Number(priorityFee),
      totalLamportsOrMist: totalLamports,
      totalUsd,
    };
  }

  /**
   * Estimate the total cost of a full rebalance cycle on SUI.
   */
  private estimateSuiCost(): GasEstimate {
    const computationCost = SUI_ESTIMATES.baseComputationCost;
    const storageCost = SUI_ESTIMATES.storageCostPerByte * BigInt(SUI_ESTIMATES.bytesPerRebalance);
    const rebate = SUI_ESTIMATES.storageRebate;
    const totalMist = computationCost + storageCost - rebate;

    // Convert MIST to SUI then to USD (1 SUI = 1e9 MIST)
    const totalSui = Number(totalMist > 0n ? totalMist : 0n) / 1e9;
    const totalUsd = totalSui * this.suiPriceUsd;

    return {
      chain: 'sui',
      baseFee: Number(computationCost),
      priorityFee: Number(storageCost),
      totalLamportsOrMist: totalMist > 0n ? totalMist : 0n,
      totalUsd,
    };
  }

  /**
   * Check if rebalance cost is justified relative to expected fee income.
   * @param estimatedCostUsd The estimated rebalance transaction cost in USD
   * @param expectedFeeIncomeUsd Expected fee income until next rebalance
   * @param threshold Maximum cost-to-income ratio (default 0.5 = 50%)
   * @returns true if the cost is justified
   */
  isCostJustified(estimatedCostUsd: number, expectedFeeIncomeUsd: number, threshold = 0.5): boolean {
    if (expectedFeeIncomeUsd <= 0) return false;
    return estimatedCostUsd / expectedFeeIncomeUsd <= threshold;
  }
}
