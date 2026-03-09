"""Performance metrics for CLMM backtest results."""

from dataclasses import dataclass
from typing import List

import numpy as np


@dataclass
class BacktestResult:
    """Raw output produced by the simulation engine for one strategy run."""

    strategy_name: str
    initial_capital: float
    final_value: float
    total_fees_earned: float
    total_il_loss: float
    total_rebalance_cost: float
    rebalance_count: int
    time_in_range_pct: float  # 0-100
    daily_values: List[float]  # portfolio value at end of each day
    num_days: int


@dataclass
class PerformanceMetrics:
    """Computed metrics for a single strategy."""

    strategy_name: str
    gross_apr_pct: float
    net_apr_pct: float
    impermanent_loss_pct: float
    sharpe_ratio: float
    max_drawdown_pct: float
    time_in_range_pct: float
    rebalance_count: int
    fee_per_rebalance: float
    total_pnl: float
    total_fees: float
    total_costs: float


def compute_metrics(result: BacktestResult, risk_free_rate: float = 0.05) -> PerformanceMetrics:
    """Compute all performance metrics from a backtest result.

    Args:
        result: Raw backtest output.
        risk_free_rate: Annualised risk-free rate for Sharpe calculation.

    Returns:
        PerformanceMetrics dataclass.
    """
    cap = result.initial_capital
    num_days = max(result.num_days, 1)
    year_fraction = num_days / 365.0

    # Gross APR: fees earned annualised
    gross_apr = (result.total_fees_earned / cap) / year_fraction * 100 if year_fraction > 0 else 0.0

    # Net PnL
    total_costs = result.total_il_loss + result.total_rebalance_cost
    net_pnl = result.total_fees_earned - total_costs
    net_apr = (net_pnl / cap) / year_fraction * 100 if year_fraction > 0 else 0.0

    # IL as percentage of initial capital
    il_pct = (result.total_il_loss / cap) * 100

    # Daily returns for Sharpe and drawdown
    values = np.array(result.daily_values)
    if len(values) > 1:
        daily_returns = np.diff(values) / values[:-1]
        daily_returns = daily_returns[np.isfinite(daily_returns)]
    else:
        daily_returns = np.array([0.0])

    # Sharpe ratio (annualised)
    if len(daily_returns) > 1 and np.std(daily_returns) > 1e-12:
        excess_daily = np.mean(daily_returns) - risk_free_rate / 365
        sharpe = excess_daily / np.std(daily_returns) * np.sqrt(365)
    else:
        sharpe = 0.0

    # Max drawdown
    if len(values) > 0:
        cummax = np.maximum.accumulate(values)
        drawdowns = (cummax - values) / np.where(cummax > 0, cummax, 1)
        max_dd = float(np.max(drawdowns)) * 100
    else:
        max_dd = 0.0

    # Fee efficiency
    fee_per_rebal = (
        result.total_fees_earned / result.rebalance_count
        if result.rebalance_count > 0
        else 0.0
    )

    return PerformanceMetrics(
        strategy_name=result.strategy_name,
        gross_apr_pct=round(gross_apr, 2),
        net_apr_pct=round(net_apr, 2),
        impermanent_loss_pct=round(il_pct, 2),
        sharpe_ratio=round(sharpe, 3),
        max_drawdown_pct=round(max_dd, 2),
        time_in_range_pct=round(result.time_in_range_pct, 2),
        rebalance_count=result.rebalance_count,
        fee_per_rebalance=round(fee_per_rebal, 2),
        total_pnl=round(net_pnl, 2),
        total_fees=round(result.total_fees_earned, 2),
        total_costs=round(total_costs, 2),
    )
