"""Text summary report generation for backtest results."""

from typing import List

from analysis.metrics import PerformanceMetrics
from config import BacktestConfig


def generate_report(
    config: BacktestConfig,
    metrics_list: List[PerformanceMetrics],
) -> str:
    """Generate a human-readable text summary comparing strategy results.

    Args:
        config: The backtest configuration used.
        metrics_list: Performance metrics for each strategy.

    Returns:
        Formatted report string.
    """
    lines: list[str] = []
    sep = "=" * 72

    lines.append(sep)
    lines.append("  CLMM AUTO-RANGE REBALANCER -- BACKTEST REPORT")
    lines.append(sep)
    lines.append("")
    lines.append("Configuration:")
    lines.append(f"  Token pair:           {config.token_pair}")
    lines.append(f"  Initial capital:      ${config.initial_capital:,.2f}")
    lines.append(f"  Period:               {config.start_date} to {config.end_date}")
    lines.append(f"  Fee tier:             {config.fee_tier * 100:.2f}%")
    lines.append(f"  Rebalance cooldown:   {config.rebalance_cooldown_hours}h")
    lines.append(f"  Max rebalances/day:   {config.max_rebalances_per_day}")
    lines.append(f"  Slippage:             {config.slippage_bps} bps")
    lines.append(f"  Swap fee:             {config.swap_fee_bps} bps")
    lines.append(f"  Gas cost:             ${config.gas_cost_usd}")
    lines.append("")
    lines.append(sep)
    lines.append("  STRATEGY RESULTS")
    lines.append(sep)

    # Sort by net APR descending
    ranked = sorted(metrics_list, key=lambda m: m.net_apr_pct, reverse=True)

    for i, m in enumerate(ranked, 1):
        lines.append("")
        tag = " <-- BEST" if i == 1 else ""
        lines.append(f"  #{i}  {m.strategy_name}{tag}")
        lines.append(f"  {'-' * 40}")
        lines.append(f"  Gross APR:           {m.gross_apr_pct:>8.2f}%")
        lines.append(f"  Net APR:             {m.net_apr_pct:>8.2f}%")
        lines.append(f"  Impermanent Loss:    {m.impermanent_loss_pct:>8.2f}%")
        lines.append(f"  Sharpe Ratio:        {m.sharpe_ratio:>8.3f}")
        lines.append(f"  Max Drawdown:        {m.max_drawdown_pct:>8.2f}%")
        lines.append(f"  Time in Range:       {m.time_in_range_pct:>8.2f}%")
        lines.append(f"  Rebalance Count:     {m.rebalance_count:>8d}")
        lines.append(f"  Fee per Rebalance:   ${m.fee_per_rebalance:>8.2f}")
        lines.append(f"  Total Fees Earned:   ${m.total_fees:>10.2f}")
        lines.append(f"  Total Costs:         ${m.total_costs:>10.2f}")
        lines.append(f"  Net PnL:             ${m.total_pnl:>10.2f}")

    lines.append("")
    lines.append(sep)
    lines.append("  SUMMARY")
    lines.append(sep)
    if ranked:
        best = ranked[0]
        lines.append(f"  Best strategy by net APR: {best.strategy_name} ({best.net_apr_pct:.2f}%)")
        if len(ranked) > 1:
            worst = ranked[-1]
            spread = best.net_apr_pct - worst.net_apr_pct
            lines.append(
                f"  Worst strategy:           {worst.strategy_name} ({worst.net_apr_pct:.2f}%)"
            )
            lines.append(f"  Spread (best - worst):    {spread:.2f} percentage points")
    lines.append(sep)
    lines.append("")

    return "\n".join(lines)


def print_report(config: BacktestConfig, metrics_list: List[PerformanceMetrics]) -> None:
    """Print the report to stdout."""
    print(generate_report(config, metrics_list))
