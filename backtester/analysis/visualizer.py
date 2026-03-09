"""Matplotlib-based charts for CLMM backtest results."""

from pathlib import Path
from typing import Dict, List, Optional, Tuple

import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
import pandas as pd

from analysis.metrics import PerformanceMetrics

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "output"


def _ensure_output_dir() -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    return OUTPUT_DIR


def plot_price_with_ranges(
    price_data: pd.DataFrame,
    range_history: List[Tuple[pd.Timestamp, float, float]],
    strategy_name: str,
    save: bool = True,
) -> Optional[Path]:
    """Plot the price path with LP range bands overlaid.

    Args:
        price_data: OHLCV DataFrame with 'timestamp' and 'close' columns.
        range_history: List of (timestamp, lower, upper) tuples marking range changes.
        strategy_name: Name for the title and filename.
        save: If True, save to output directory.

    Returns:
        Path to saved figure, or None if not saved.
    """
    fig, ax = plt.subplots(figsize=(14, 6))

    timestamps = pd.to_datetime(price_data["timestamp"], utc=True)
    ax.plot(timestamps, price_data["close"], linewidth=1, color="black", label="Price")

    # Draw range bands as shaded regions between rebalances
    for i, (ts, lower, upper) in enumerate(range_history):
        ts = pd.Timestamp(ts, tz="UTC") if ts.tzinfo is None else ts
        end_ts = range_history[i + 1][0] if i + 1 < len(range_history) else timestamps.iloc[-1]
        end_ts = pd.Timestamp(end_ts, tz="UTC") if end_ts.tzinfo is None else end_ts
        mask = (timestamps >= ts) & (timestamps <= end_ts)
        ts_slice = timestamps[mask]
        if len(ts_slice) == 0:
            continue
        ax.fill_between(ts_slice, lower, upper, alpha=0.15, color="blue")
        ax.axhline(y=lower, xmin=0, xmax=1, color="blue", linewidth=0.3, alpha=0.3)
        ax.axhline(y=upper, xmin=0, xmax=1, color="blue", linewidth=0.3, alpha=0.3)

    ax.set_title(f"Price & LP Range -- {strategy_name}")
    ax.set_xlabel("Date")
    ax.set_ylabel("Price (USD)")
    ax.legend()
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m-%d"))
    fig.autofmt_xdate()
    fig.tight_layout()

    if save:
        out = _ensure_output_dir() / f"price_range_{strategy_name}.png"
        fig.savefig(out, dpi=150)
        plt.close(fig)
        return out
    plt.show()
    return None


def plot_cumulative_pnl(
    daily_values_by_strategy: Dict[str, List[float]],
    initial_capital: float,
    dates: List,
    save: bool = True,
) -> Optional[Path]:
    """Plot cumulative PnL over time for each strategy.

    Args:
        daily_values_by_strategy: {strategy_name: [daily portfolio values]}.
        initial_capital: Starting capital.
        dates: List of date labels.
        save: If True, save to output directory.

    Returns:
        Path or None.
    """
    fig, ax = plt.subplots(figsize=(14, 6))

    for name, values in daily_values_by_strategy.items():
        pnl = [v - initial_capital for v in values]
        n = len(pnl)
        ax.plot(dates[:n], pnl, linewidth=1.2, label=name)

    ax.axhline(y=0, color="gray", linestyle="--", linewidth=0.8)
    ax.set_title("Cumulative PnL by Strategy")
    ax.set_xlabel("Date")
    ax.set_ylabel("PnL (USD)")
    ax.legend()
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y-%m-%d"))
    fig.autofmt_xdate()
    fig.tight_layout()

    if save:
        out = _ensure_output_dir() / "cumulative_pnl.png"
        fig.savefig(out, dpi=150)
        plt.close(fig)
        return out
    plt.show()
    return None


def plot_il_decomposition(
    metrics_list: List[PerformanceMetrics],
    save: bool = True,
) -> Optional[Path]:
    """Bar chart decomposing PnL into fees, IL, and rebalance costs.

    Args:
        metrics_list: List of PerformanceMetrics for each strategy.
        save: If True, save to output directory.

    Returns:
        Path or None.
    """
    fig, ax = plt.subplots(figsize=(10, 6))

    names = [m.strategy_name for m in metrics_list]
    fees = [m.total_fees for m in metrics_list]
    il = [-m.impermanent_loss_pct for m in metrics_list]  # negative because it's a loss
    costs = [-m.total_costs for m in metrics_list]
    net = [m.total_pnl for m in metrics_list]

    x = np.arange(len(names))
    width = 0.2

    ax.bar(x - 1.5 * width, fees, width, label="Fees Earned", color="green")
    ax.bar(x - 0.5 * width, costs, width, label="Total Costs", color="red")
    ax.bar(x + 0.5 * width, net, width, label="Net PnL", color="blue")

    ax.set_xticks(x)
    ax.set_xticklabels(names, rotation=15, ha="right")
    ax.set_ylabel("USD")
    ax.set_title("PnL Decomposition by Strategy")
    ax.legend()
    fig.tight_layout()

    if save:
        out = _ensure_output_dir() / "il_decomposition.png"
        fig.savefig(out, dpi=150)
        plt.close(fig)
        return out
    plt.show()
    return None


def plot_strategy_comparison(
    metrics_list: List[PerformanceMetrics],
    save: bool = True,
) -> Optional[Path]:
    """Side-by-side bar charts comparing key metrics across strategies.

    Args:
        metrics_list: List of PerformanceMetrics.
        save: If True, save to output directory.

    Returns:
        Path or None.
    """
    fig, axes = plt.subplots(2, 3, figsize=(16, 8))
    names = [m.strategy_name for m in metrics_list]

    chart_data = [
        ("Net APR %", [m.net_apr_pct for m in metrics_list], "steelblue"),
        ("Gross APR %", [m.gross_apr_pct for m in metrics_list], "green"),
        ("Sharpe Ratio", [m.sharpe_ratio for m in metrics_list], "purple"),
        ("Max Drawdown %", [m.max_drawdown_pct for m in metrics_list], "red"),
        ("Time in Range %", [m.time_in_range_pct for m in metrics_list], "orange"),
        ("Rebalance Count", [m.rebalance_count for m in metrics_list], "teal"),
    ]

    for ax, (title, values, color) in zip(axes.flat, chart_data):
        ax.bar(names, values, color=color, alpha=0.8)
        ax.set_title(title)
        ax.tick_params(axis="x", rotation=15)

    fig.suptitle("Strategy Comparison", fontsize=14)
    fig.tight_layout()

    if save:
        out = _ensure_output_dir() / "strategy_comparison.png"
        fig.savefig(out, dpi=150)
        plt.close(fig)
        return out
    plt.show()
    return None
