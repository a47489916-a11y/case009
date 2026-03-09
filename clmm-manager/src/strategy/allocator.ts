/**
 * Multi-pool capital allocation manager.
 * Manages target weights and rebalances allocations when drift exceeds threshold.
 */

import { getLogger } from '../utils/logger.ts';
import type { PoolAllocation } from '../core/types.ts';

/** Result of an allocation analysis. */
export interface AllocationStatus {
  pool: string;
  chain: string;
  dex: string;
  targetWeight: number;
  currentWeight: number;
  driftPct: number;
  currentValueUsd: number;
  targetValueUsd: number;
  adjustmentUsd: number;
}

/** Default pool allocation weights. */
const DEFAULT_ALLOCATIONS: PoolAllocation[] = [
  { pool: 'SOL/USDC', chain: 'solana', dex: 'orca', weight: 0.625 },
  { pool: 'SOL/mSOL', chain: 'solana', dex: 'orca', weight: 0.10 },
  { pool: 'SUI/USDC', chain: 'sui', dex: 'cetus', weight: 0.15 },
];

/**
 * Capital allocation manager for distributing funds across multiple CLMM pools.
 */
export class CapitalAllocator {
  private readonly allocations: PoolAllocation[];
  private readonly usdcReservePct: number;
  /** Maximum drift before triggering an allocation rebalance (default 5%). */
  private readonly driftThreshold: number;

  constructor(params: {
    pools?: PoolAllocation[];
    usdcReservePct?: number;
    driftThreshold?: number;
  } = {}) {
    this.allocations = params.pools ?? DEFAULT_ALLOCATIONS;
    this.usdcReservePct = params.usdcReservePct ?? 0.125;
    this.driftThreshold = params.driftThreshold ?? 0.05;

    this.validateAllocations();
  }

  /** Validate that pool weights + USDC reserve sum to approximately 1.0. */
  private validateAllocations(): void {
    const poolWeightSum = this.allocations.reduce((sum, a) => sum + a.weight, 0);
    const total = poolWeightSum + this.usdcReservePct;

    if (Math.abs(total - 1.0) > 0.01) {
      getLogger().warn('Allocation weights do not sum to 1.0', {
        poolWeightSum,
        usdcReservePct: this.usdcReservePct,
        total,
      });
    }
  }

  /**
   * Analyze current allocations against targets.
   * @param poolValues Map of pool identifier to current USD value
   * @param reserveValueUsd Current USDC reserve value
   * @returns Array of allocation status for each pool
   */
  analyzeAllocations(
    poolValues: Map<string, number>,
    reserveValueUsd: number
  ): AllocationStatus[] {
    const totalValue = Array.from(poolValues.values()).reduce((a, b) => a + b, 0) + reserveValueUsd;

    if (totalValue === 0) {
      return this.allocations.map((a) => ({
        pool: a.pool,
        chain: a.chain,
        dex: a.dex,
        targetWeight: a.weight,
        currentWeight: 0,
        driftPct: 0,
        currentValueUsd: 0,
        targetValueUsd: 0,
        adjustmentUsd: 0,
      }));
    }

    return this.allocations.map((alloc) => {
      const currentValue = poolValues.get(alloc.pool) ?? 0;
      const currentWeight = currentValue / totalValue;
      const targetValue = totalValue * alloc.weight;
      const driftPct = Math.abs(currentWeight - alloc.weight);
      const adjustmentUsd = targetValue - currentValue;

      return {
        pool: alloc.pool,
        chain: alloc.chain,
        dex: alloc.dex,
        targetWeight: alloc.weight,
        currentWeight,
        driftPct,
        currentValueUsd: currentValue,
        targetValueUsd: targetValue,
        adjustmentUsd,
      };
    });
  }

  /**
   * Determine if allocation rebalancing is needed (any pool exceeds drift threshold).
   * @param poolValues Map of pool identifier to current USD value
   * @param reserveValueUsd Current USDC reserve value
   * @returns true if rebalancing is recommended
   */
  needsRebalance(poolValues: Map<string, number>, reserveValueUsd: number): boolean {
    const statuses = this.analyzeAllocations(poolValues, reserveValueUsd);
    return statuses.some((s) => s.driftPct > this.driftThreshold);
  }

  /**
   * Calculate USDC reserve target.
   * @param totalPortfolioUsd Total portfolio value in USD
   * @returns Target reserve amount in USD
   */
  getReserveTarget(totalPortfolioUsd: number): number {
    return totalPortfolioUsd * this.usdcReservePct;
  }

  /**
   * Get the target allocation for a specific pool.
   * @param pool Pool identifier (e.g., 'SOL/USDC')
   */
  getPoolAllocation(pool: string): PoolAllocation | undefined {
    return this.allocations.find((a) => a.pool === pool);
  }

  /** Get all configured pool allocations. */
  getAllocations(): readonly PoolAllocation[] {
    return this.allocations;
  }
}
