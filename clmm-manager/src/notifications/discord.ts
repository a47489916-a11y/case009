/**
 * Discord webhook notifications.
 * Sends position updates, rebalance alerts, and daily summaries.
 */

import { getLogger } from '../utils/logger.ts';
import type {
  Position,
  RebalanceAction,
  PositionStatus,
  DailySummary,
  NotificationLevel,
} from '../core/types.ts';

/** Discord embed color codes. */
const COLORS = {
  green: 0x2ecc71,
  yellow: 0xf1c40f,
  red: 0xe74c3c,
  blue: 0x3498db,
  gray: 0x95a5a6,
} as const;

/** Map notification level to embed color. */
function levelToColor(level: NotificationLevel): number {
  switch (level) {
    case 'info':
      return COLORS.green;
    case 'warning':
      return COLORS.yellow;
    case 'critical':
      return COLORS.red;
  }
}

/** Map position status to embed color. */
function statusToColor(status: PositionStatus): number {
  switch (status) {
    case 'in_range':
      return COLORS.green;
    case 'near_boundary':
      return COLORS.yellow;
    case 'out_of_range':
      return COLORS.red;
  }
}

/** Discord webhook embed structure. */
interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

/**
 * Discord webhook notification service.
 */
export class DiscordNotifier {
  private readonly webhookUrl: string;
  private readonly enabled: boolean;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl;
    this.enabled = webhookUrl.length > 0 && webhookUrl.startsWith('https://');

    if (!this.enabled) {
      getLogger().warn('Discord notifications disabled (no valid webhook URL configured)');
    }
  }

  /**
   * Send a raw Discord webhook message with embeds.
   */
  private async send(embeds: DiscordEmbed[]): Promise<void> {
    if (!this.enabled) return;

    const logger = getLogger();

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        logger.error('Discord webhook failed', {
          status: response.status,
          statusText: response.statusText,
        });
      }
    } catch (err) {
      logger.error('Discord webhook error', { error: (err as Error).message });
    }
  }

  /**
   * Notify about a position status change.
   */
  async notifyPositionStatus(
    position: Position,
    status: PositionStatus,
    currentPrice: number
  ): Promise<void> {
    const statusLabel = status.replace(/_/g, ' ').toUpperCase();

    await this.send([
      {
        title: `Position Status: ${statusLabel}`,
        color: statusToColor(status),
        fields: [
          { name: 'Pool', value: position.pool, inline: true },
          { name: 'Chain/DEX', value: `${position.chain}/${position.dex}`, inline: true },
          { name: 'Current Price', value: `$${currentPrice.toFixed(4)}`, inline: true },
          { name: 'Range', value: `$${position.lowerPrice.toFixed(4)} - $${position.upperPrice.toFixed(4)}`, inline: false },
          { name: 'Value', value: `$${position.currentValueUsd.toFixed(2)}`, inline: true },
          { name: 'Fees Earned', value: `$${position.feesEarnedUsd.toFixed(2)}`, inline: true },
        ],
        timestamp: new Date().toISOString(),
      },
    ]);
  }

  /**
   * Notify about a rebalance execution.
   */
  async notifyRebalance(action: RebalanceAction, success: boolean): Promise<void> {
    const color = success ? COLORS.green : COLORS.red;
    const title = success ? 'Rebalance Executed' : 'Rebalance Failed';

    await this.send([
      {
        title,
        color,
        fields: [
          { name: 'Position', value: action.positionId, inline: true },
          { name: 'Reason', value: action.reason, inline: true },
          { name: 'Old Range', value: `$${action.oldRange[0].toFixed(4)} - $${action.oldRange[1].toFixed(4)}`, inline: false },
          { name: 'New Range', value: `$${action.newRange[0].toFixed(4)} - $${action.newRange[1].toFixed(4)}`, inline: false },
          { name: 'Estimated Cost', value: `$${action.estimatedCost.toFixed(4)}`, inline: true },
        ],
        timestamp: action.timestamp.toISOString(),
      },
    ]);
  }

  /**
   * Notify about a circuit breaker activation.
   */
  async notifyCircuitBreaker(reason: string, severity: NotificationLevel): Promise<void> {
    await this.send([
      {
        title: 'Circuit Breaker Activated',
        description: reason,
        color: levelToColor(severity),
        footer: { text: `Severity: ${severity.toUpperCase()}` },
        timestamp: new Date().toISOString(),
      },
    ]);
  }

  /**
   * Send a daily summary report.
   */
  async notifyDailySummary(summary: DailySummary): Promise<void> {
    const posFields = summary.positions.map((p) => ({
      name: `${p.pool} (${p.status.replace(/_/g, ' ')})`,
      value: `Value: $${p.valueUsd.toFixed(2)} | Fees: $${p.feesUsd.toFixed(2)} | IL: ${(p.ilPct * 100).toFixed(2)}%`,
      inline: false,
    }));

    await this.send([
      {
        title: `Daily Summary - ${summary.date}`,
        color: COLORS.blue,
        fields: [
          { name: 'Total Value', value: `$${summary.totalValueUsd.toFixed(2)}`, inline: true },
          { name: 'Total Fees', value: `$${summary.totalFeesUsd.toFixed(2)}`, inline: true },
          { name: 'Total IL', value: `$${summary.totalIlUsd.toFixed(2)}`, inline: true },
          { name: 'Rebalances', value: `${summary.rebalanceCount}`, inline: true },
          ...posFields,
        ],
        timestamp: new Date().toISOString(),
      },
    ]);
  }

  /**
   * Send a general error alert.
   */
  async notifyError(title: string, error: string): Promise<void> {
    await this.send([
      {
        title: `Error: ${title}`,
        description: error,
        color: COLORS.red,
        timestamp: new Date().toISOString(),
      },
    ]);
  }
}
