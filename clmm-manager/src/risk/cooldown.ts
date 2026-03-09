/**
 * Rebalance cooldown manager.
 * Enforces minimum time between rebalances and daily limits.
 */

import { getLogger } from '../utils/logger.ts';
import { getLastRebalanceTime, getTodayRebalanceCount } from '../utils/db.ts';

/**
 * Manages rebalance cooldowns and daily limits.
 */
export class CooldownManager {
  private readonly cooldownHours: number;
  private readonly maxRebalancesPerDay: number;

  /** In-memory fallback tracking when DB is not available. */
  private lastRebalanceTimes = new Map<string, Date>();
  private dailyCount = 0;
  private dailyCountDate: string = '';

  constructor(params: { cooldownHours: number; maxRebalancesPerDay: number }) {
    this.cooldownHours = params.cooldownHours;
    this.maxRebalancesPerDay = params.maxRebalancesPerDay;
  }

  /**
   * Check if a position is allowed to rebalance based on cooldown rules.
   * @param positionId The position identifier
   * @returns Object with allowed flag and reason
   */
  canRebalance(positionId: string): { allowed: boolean; reason: string; waitMs?: number } {
    const logger = getLogger();

    // Check daily limit
    const todayCount = this.getTodayCount();
    if (todayCount >= this.maxRebalancesPerDay) {
      return {
        allowed: false,
        reason: `Daily rebalance limit reached: ${todayCount}/${this.maxRebalancesPerDay}`,
      };
    }

    // Check per-position cooldown
    const lastRebalance = this.getLastRebalance(positionId);
    if (lastRebalance) {
      const elapsedMs = Date.now() - lastRebalance.getTime();
      const cooldownMs = this.cooldownHours * 3600_000;

      if (elapsedMs < cooldownMs) {
        const remainingMs = cooldownMs - elapsedMs;
        const remainingHours = (remainingMs / 3600_000).toFixed(1);
        return {
          allowed: false,
          reason: `Cooldown active for position ${positionId}: ${remainingHours}h remaining`,
          waitMs: remainingMs,
        };
      }
    }

    logger.debug('Rebalance allowed', { positionId, todayCount });
    return { allowed: true, reason: 'Cooldown check passed' };
  }

  /**
   * Record that a rebalance was executed.
   * @param positionId The position identifier
   */
  recordRebalance(positionId: string): void {
    const now = new Date();
    this.lastRebalanceTimes.set(positionId, now);

    // Update daily count
    const today = now.toISOString().slice(0, 10);
    if (this.dailyCountDate !== today) {
      this.dailyCount = 0;
      this.dailyCountDate = today;
    }
    this.dailyCount++;
  }

  /**
   * Get the current day's rebalance count.
   * Tries DB first, falls back to in-memory.
   */
  private getTodayCount(): number {
    try {
      return getTodayRebalanceCount();
    } catch {
      // DB not available, use in-memory tracking
      const today = new Date().toISOString().slice(0, 10);
      if (this.dailyCountDate !== today) {
        this.dailyCount = 0;
        this.dailyCountDate = today;
      }
      return this.dailyCount;
    }
  }

  /**
   * Get the last rebalance time for a position.
   * Tries DB first, falls back to in-memory.
   */
  private getLastRebalance(positionId: string): Date | null {
    try {
      const dbTime = getLastRebalanceTime(positionId);
      const memTime = this.lastRebalanceTimes.get(positionId) ?? null;

      if (dbTime && memTime) {
        return dbTime.getTime() > memTime.getTime() ? dbTime : memTime;
      }
      return dbTime ?? memTime;
    } catch {
      return this.lastRebalanceTimes.get(positionId) ?? null;
    }
  }

  /**
   * Reset the daily counter. Called at UTC midnight.
   */
  resetDailyCount(): void {
    this.dailyCount = 0;
    this.dailyCountDate = new Date().toISOString().slice(0, 10);
  }

  /**
   * Get remaining cooldown time for a position in milliseconds.
   * Returns 0 if no cooldown is active.
   */
  getRemainingCooldownMs(positionId: string): number {
    const lastRebalance = this.getLastRebalance(positionId);
    if (!lastRebalance) return 0;

    const elapsedMs = Date.now() - lastRebalance.getTime();
    const cooldownMs = this.cooldownHours * 3600_000;
    return Math.max(0, cooldownMs - elapsedMs);
  }
}
