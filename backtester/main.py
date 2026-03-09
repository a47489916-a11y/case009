#!/usr/bin/env python3
"""CLMM Auto-Range Rebalancer Backtester -- Entry Point.

Usage:
    python main.py                   # Run with defaults (Monte Carlo data)
    python main.py --live            # Fetch live data from CoinGecko
    python main.py --token SOL/USDC  # Override token pair
    python main.py --capital 100000  # Override initial capital
"""

import argparse
import math
import sys
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Ensure the backtester package root is on sys.path so imports resolve
# regardless of the working directory.
# ---------------------------------------------------------------------------
_THIS_DIR = Path(__file__).resolve().parent
if str(_THIS_DIR) not in sys.path:
    sys.path.insert(0, str(_THIS_DIR))

from config import BacktestConfig
from strategies.base import BaseStrategy
from strategies.fixed_pct import FixedPercentageStrategy
from strategies.volatility_2sigma import Volatility2SigmaStrategy
from strategies.bollinger import BollingerStrategy
from analysis.metrics import BacktestResult, PerformanceMetrics, compute_metrics
from analysis.visualizer import (
    plot_price_with_ranges,
    plot_cumulative_pnl,
    plot_il_decomposition,
    plot_strategy_comparison,
)
from analysis.report import generate_report, print_report


# =========================================================================
# CLMM Simulation Engine
# =========================================================================

@dataclass
class PositionState:
    """Tracks the current LP position state."""
    lower: float = 0.0
    upper: float = 0.0
    capital: float = 0.0
    liquidity: float = 0.0  # virtual liquidity units
    entry_price: float = 0.0
    fees_accrued: float = 0.0
    il_accrued: float = 0.0
    rebalance_costs: float = 0.0
    rebalance_count: int = 0
    in_range_steps: int = 0
    total_steps: int = 0
    last_rebalance_time: Optional[datetime] = None
    daily_rebalance_count: int = 0
    current_day: Optional[str] = None


def _compute_il(price_ratio: float) -> float:
    """Impermanent loss for a concentrated position.

    IL = 2 * sqrt(price_ratio) / (1 + price_ratio) - 1

    Args:
        price_ratio: current_price / entry_price.

    Returns:
        IL as a negative fraction (e.g. -0.05 for 5% loss).
    """
    if price_ratio <= 0:
        return -1.0
    il = 2 * math.sqrt(price_ratio) / (1 + price_ratio) - 1
    return il


def _estimate_fee_income(
    capital: float,
    fee_tier: float,
    volume_multiplier: float,
    price: float,
    lower: float,
    upper: float,
) -> float:
    """Estimate fees earned for one time step (1 day) while in range.

    Fee model:
        daily_fees = capital * fee_tier * volume_proxy * concentration_factor

    The concentration factor rewards tighter ranges: capital is more concentrated
    so it earns a larger share of the pool fees.
    concentration_factor = reference_range / actual_range  (capped)
    """
    if upper <= lower or price <= 0:
        return 0.0

    range_width = (upper - lower) / price
    # A full-range position would cover ~200% width; our concentrated position
    # earns proportionally more.  We use 1.0 as the reference width.
    concentration = min(1.0 / max(range_width, 0.01), 50.0)

    # Volume proxy: assume daily volume ~ 5x the position size for liquid pairs
    volume_proxy = volume_multiplier * 5.0

    daily_fees = capital * fee_tier * volume_proxy * concentration / 365.0
    return daily_fees


def simulate_strategy(
    strategy: BaseStrategy,
    price_data: pd.DataFrame,
    config: BacktestConfig,
) -> BacktestResult:
    """Run the CLMM backtest simulation for a single strategy.

    Steps per day:
    1. Check if price is in range; if so, accrue fees.
    2. Compute IL relative to position entry price.
    3. Check rebalance trigger; if triggered, pay costs and open new range.
    4. Record daily portfolio value.

    Args:
        strategy: The range strategy to evaluate.
        price_data: OHLCV DataFrame with 'timestamp', 'close', etc.
        config: Backtest configuration.

    Returns:
        BacktestResult with all simulation outputs.
    """
    pos = PositionState(capital=config.initial_capital)
    daily_values: List[float] = []
    range_history: List[Tuple[pd.Timestamp, float, float]] = []

    prices = price_data.copy().reset_index(drop=True)
    if "timestamp" in prices.columns:
        prices["timestamp"] = pd.to_datetime(prices["timestamp"], utc=True)
    else:
        prices["timestamp"] = pd.date_range(
            start=config.start_date, periods=len(prices), freq="D", tz="UTC"
        )

    n = len(prices)
    if n == 0:
        return BacktestResult(
            strategy_name=strategy.name,
            initial_capital=config.initial_capital,
            final_value=config.initial_capital,
            total_fees_earned=0.0,
            total_il_loss=0.0,
            total_rebalance_cost=0.0,
            rebalance_count=0,
            time_in_range_pct=0.0,
            daily_values=[config.initial_capital],
            num_days=0,
        )

    # --- Initial position ---
    first_price = float(prices["close"].iloc[0])
    lookback = prices.iloc[:1]
    lower, upper = strategy.calculate_range(first_price, lookback)
    pos.lower = lower
    pos.upper = upper
    pos.entry_price = first_price
    pos.last_rebalance_time = prices["timestamp"].iloc[0]
    range_history.append((prices["timestamp"].iloc[0], lower, upper))

    for i in range(n):
        row = prices.iloc[i]
        price = float(row["close"])
        ts = row["timestamp"]
        day_str = str(ts.date()) if hasattr(ts, "date") else str(ts)[:10]

        # Reset daily rebalance counter
        if pos.current_day != day_str:
            pos.current_day = day_str
            pos.daily_rebalance_count = 0

        pos.total_steps += 1
        in_range = pos.lower <= price <= pos.upper

        # ---- Fee accrual ----
        if in_range:
            pos.in_range_steps += 1
            fee = _estimate_fee_income(
                pos.capital, config.fee_tier, config.volume_multiplier,
                price, pos.lower, pos.upper,
            )
            pos.fees_accrued += fee

        # ---- IL computation ----
        if pos.entry_price > 0:
            price_ratio = price / pos.entry_price
            il_frac = _compute_il(price_ratio)
            # IL is measured on the portion of capital deployed as LP
            current_il = abs(il_frac) * pos.capital
        else:
            current_il = 0.0

        # ---- Rebalance check ----
        lookback_end = min(i + 1, n)
        lookback_start = max(0, lookback_end - 60)
        hist = prices.iloc[lookback_start:lookback_end]

        should_rebal = strategy.should_rebalance(
            price, pos.lower, pos.upper,
            pos.last_rebalance_time, ts,
            cooldown_hours=config.rebalance_cooldown_hours,
        )

        if should_rebal and pos.daily_rebalance_count < config.max_rebalances_per_day:
            # Pay rebalance costs
            swap_cost = pos.capital * config.swap_fee_pct
            slippage_cost = pos.capital * config.slippage_pct
            gas = config.gas_cost_usd
            total_cost = swap_cost + slippage_cost + gas

            pos.capital -= total_cost
            pos.rebalance_costs += total_cost
            pos.rebalance_count += 1
            pos.daily_rebalance_count += 1

            # Realise IL on rebalance
            pos.il_accrued += current_il
            pos.capital -= current_il

            # Open new range
            new_lower, new_upper = strategy.calculate_range(price, hist)
            pos.lower = new_lower
            pos.upper = new_upper
            pos.entry_price = price
            pos.last_rebalance_time = ts
            range_history.append((ts, new_lower, new_upper))

        # ---- Daily portfolio value ----
        # Value = remaining capital + unrealised fees - unrealised IL
        unrealised_il = current_il if pos.entry_price > 0 else 0.0
        portfolio_value = pos.capital + pos.fees_accrued - unrealised_il
        daily_values.append(max(portfolio_value, 0.0))

    time_in_range = (
        (pos.in_range_steps / pos.total_steps * 100) if pos.total_steps > 0 else 0.0
    )

    return BacktestResult(
        strategy_name=strategy.name,
        initial_capital=config.initial_capital,
        final_value=daily_values[-1] if daily_values else config.initial_capital,
        total_fees_earned=pos.fees_accrued,
        total_il_loss=pos.il_accrued,
        total_rebalance_cost=pos.rebalance_costs,
        rebalance_count=pos.rebalance_count,
        time_in_range_pct=time_in_range,
        daily_values=daily_values,
        num_days=n,
    ), range_history  # type: ignore[return-value]


# Wrapper so we can return range_history alongside the result
def _run_strategy(
    strategy: BaseStrategy, price_data: pd.DataFrame, config: BacktestConfig
) -> Tuple[BacktestResult, List[Tuple]]:
    """Run simulation and return (result, range_history)."""
    pos = PositionState(capital=config.initial_capital)
    daily_values: List[float] = []
    range_history: List[Tuple] = []

    prices = price_data.copy().reset_index(drop=True)
    if "timestamp" in prices.columns:
        prices["timestamp"] = pd.to_datetime(prices["timestamp"], utc=True)
    else:
        prices["timestamp"] = pd.date_range(
            start=config.start_date, periods=len(prices), freq="D", tz="UTC"
        )

    n = len(prices)
    if n == 0:
        empty = BacktestResult(
            strategy_name=strategy.name,
            initial_capital=config.initial_capital,
            final_value=config.initial_capital,
            total_fees_earned=0.0,
            total_il_loss=0.0,
            total_rebalance_cost=0.0,
            rebalance_count=0,
            time_in_range_pct=0.0,
            daily_values=[config.initial_capital],
            num_days=0,
        )
        return empty, []

    first_price = float(prices["close"].iloc[0])
    lookback = prices.iloc[:1]
    lower, upper = strategy.calculate_range(first_price, lookback)
    pos.lower = lower
    pos.upper = upper
    pos.entry_price = first_price
    pos.last_rebalance_time = prices["timestamp"].iloc[0]
    range_history.append((prices["timestamp"].iloc[0], lower, upper))

    for i in range(n):
        row = prices.iloc[i]
        price = float(row["close"])
        ts = row["timestamp"]
        day_str = str(ts.date()) if hasattr(ts, "date") else str(ts)[:10]

        if pos.current_day != day_str:
            pos.current_day = day_str
            pos.daily_rebalance_count = 0

        pos.total_steps += 1
        in_range = pos.lower <= price <= pos.upper

        if in_range:
            pos.in_range_steps += 1
            fee = _estimate_fee_income(
                pos.capital, config.fee_tier, config.volume_multiplier,
                price, pos.lower, pos.upper,
            )
            pos.fees_accrued += fee

        if pos.entry_price > 0:
            price_ratio = price / pos.entry_price
            il_frac = _compute_il(price_ratio)
            current_il = abs(il_frac) * pos.capital
        else:
            current_il = 0.0

        lookback_end = min(i + 1, n)
        lookback_start = max(0, lookback_end - 60)
        hist = prices.iloc[lookback_start:lookback_end]

        should_rebal = strategy.should_rebalance(
            price, pos.lower, pos.upper,
            pos.last_rebalance_time, ts,
            cooldown_hours=config.rebalance_cooldown_hours,
        )

        if should_rebal and pos.daily_rebalance_count < config.max_rebalances_per_day:
            swap_cost = pos.capital * config.swap_fee_pct
            slippage_cost = pos.capital * config.slippage_pct
            gas = config.gas_cost_usd
            total_cost = swap_cost + slippage_cost + gas

            pos.capital -= total_cost
            pos.rebalance_costs += total_cost
            pos.rebalance_count += 1
            pos.daily_rebalance_count += 1

            pos.il_accrued += current_il
            pos.capital -= current_il

            new_lower, new_upper = strategy.calculate_range(price, hist)
            pos.lower = new_lower
            pos.upper = new_upper
            pos.entry_price = price
            pos.last_rebalance_time = ts
            range_history.append((ts, new_lower, new_upper))

        unrealised_il = current_il if pos.entry_price > 0 else 0.0
        portfolio_value = pos.capital + pos.fees_accrued - unrealised_il
        daily_values.append(max(portfolio_value, 0.0))

    time_in_range = (
        (pos.in_range_steps / pos.total_steps * 100) if pos.total_steps > 0 else 0.0
    )

    result = BacktestResult(
        strategy_name=strategy.name,
        initial_capital=config.initial_capital,
        final_value=daily_values[-1] if daily_values else config.initial_capital,
        total_fees_earned=pos.fees_accrued,
        total_il_loss=pos.il_accrued,
        total_rebalance_cost=pos.rebalance_costs,
        rebalance_count=pos.rebalance_count,
        time_in_range_pct=time_in_range,
        daily_values=daily_values,
        num_days=n,
    )
    return result, range_history


# =========================================================================
# Data loading
# =========================================================================

def load_price_data(config: BacktestConfig, use_live: bool = False) -> pd.DataFrame:
    """Load price data from cache/API or generate via Monte Carlo.

    Args:
        config: Backtest configuration.
        use_live: If True, fetch from CoinGecko (with caching).

    Returns:
        OHLCV DataFrame.
    """
    if use_live:
        from data.cache import get_or_fetch
        return get_or_fetch(config.token_pair, config.start_date, config.end_date)

    # Default: generate synthetic data via Monte Carlo
    from data.monte_carlo import generate_ohlcv

    print(f"  [monte_carlo] Generating synthetic {config.token_pair} price data...")
    token = config.base_token
    # Use parameters loosely calibrated to each token
    params = {
        "SOL": {"s0": 100.0, "mu": 0.5, "sigma": 0.9},
        "SUI": {"s0": 1.5, "mu": 0.3, "sigma": 1.0},
        "ETH": {"s0": 2300.0, "mu": 0.2, "sigma": 0.7},
        "BTC": {"s0": 42000.0, "mu": 0.3, "sigma": 0.6},
    }
    p = params.get(token.upper(), {"s0": 100.0, "mu": 0.0, "sigma": 0.8})

    start = datetime.fromisoformat(config.start_date)
    end = datetime.fromisoformat(config.end_date)
    num_days = (end - start).days

    dfs = generate_ohlcv(
        s0=p["s0"],
        mu=p["mu"],
        sigma=p["sigma"],
        num_days=num_days,
        num_paths=1,
        start_date=config.start_date,
        seed=42,
    )
    return dfs[0]


# =========================================================================
# CLI
# =========================================================================

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="CLMM Auto-Range Rebalancer Backtester")
    parser.add_argument("--live", action="store_true", help="Fetch live data from CoinGecko")
    parser.add_argument("--token", type=str, default="SOL/USDC", help="Token pair (e.g. SOL/USDC)")
    parser.add_argument("--capital", type=float, default=50_000.0, help="Initial capital in USD")
    parser.add_argument("--start", type=str, default="2024-01-01", help="Start date (ISO)")
    parser.add_argument("--end", type=str, default="2024-12-31", help="End date (ISO)")
    parser.add_argument("--fee-tier", type=float, default=0.003, help="Pool fee tier (e.g. 0.003)")
    parser.add_argument("--cooldown", type=int, default=6, help="Rebalance cooldown hours")
    parser.add_argument("--no-charts", action="store_true", help="Skip chart generation")
    return parser.parse_args()


# =========================================================================
# Main
# =========================================================================

def main() -> None:
    args = parse_args()

    config = BacktestConfig(
        token_pair=args.token,
        initial_capital=args.capital,
        start_date=args.start,
        end_date=args.end,
        fee_tier=args.fee_tier,
        rebalance_cooldown_hours=args.cooldown,
    )

    print("=" * 60)
    print("  CLMM Auto-Range Rebalancer Backtester")
    print("=" * 60)
    print(f"  Pair:    {config.token_pair}")
    print(f"  Capital: ${config.initial_capital:,.0f}")
    print(f"  Period:  {config.start_date} -> {config.end_date}")
    print(f"  Source:  {'CoinGecko (live)' if args.live else 'Monte Carlo (synthetic)'}")
    print()

    # ---- Load data ----
    print("[1/4] Loading price data...")
    price_data = load_price_data(config, use_live=args.live)
    print(f"  Loaded {len(price_data)} daily candles.")
    print(f"  Price range: ${price_data['close'].min():.2f} - ${price_data['close'].max():.2f}")
    print()

    # ---- Define strategies ----
    base_token = config.base_token
    strategies: List[BaseStrategy] = [
        Volatility2SigmaStrategy(
            holding_days=config.holding_days,
            token=base_token,
        ),
        FixedPercentageStrategy(pct=0.05),
        FixedPercentageStrategy(pct=0.10),
        BollingerStrategy(),
    ]

    # ---- Run simulations ----
    print("[2/4] Running simulations...")
    results: List[BacktestResult] = []
    range_histories: Dict[str, List[Tuple]] = {}

    # Run strategies using ThreadPoolExecutor for parallelism
    # (CPU-bound but GIL-limited; still useful for I/O overlap in live mode)
    with ThreadPoolExecutor(max_workers=len(strategies)) as pool:
        futures = {
            pool.submit(_run_strategy, strat, price_data, config): strat.name
            for strat in strategies
        }
        for future in futures:
            name = futures[future]
            result, rh = future.result()
            results.append(result)
            range_histories[name] = rh
            print(f"  Completed: {name}")

    print()

    # ---- Compute metrics ----
    print("[3/4] Computing metrics...")
    all_metrics: List[PerformanceMetrics] = []
    for r in results:
        m = compute_metrics(r)
        all_metrics.append(m)

    # ---- Report ----
    print("[4/4] Generating report...")
    print()
    print_report(config, all_metrics)

    # ---- Charts ----
    if not args.no_charts:
        print("Generating charts...")
        dates = price_data["timestamp"].tolist() if "timestamp" in price_data.columns else list(
            range(len(price_data))
        )

        # Price + range charts for each strategy
        for strat_name, rh in range_histories.items():
            path = plot_price_with_ranges(price_data, rh, strat_name)
            if path:
                print(f"  Saved: {path}")

        # Cumulative PnL
        daily_vals = {r.strategy_name: r.daily_values for r in results}
        path = plot_cumulative_pnl(daily_vals, config.initial_capital, dates)
        if path:
            print(f"  Saved: {path}")

        # IL decomposition
        path = plot_il_decomposition(all_metrics)
        if path:
            print(f"  Saved: {path}")

        # Strategy comparison
        path = plot_strategy_comparison(all_metrics)
        if path:
            print(f"  Saved: {path}")

    print()
    print("Done.")


if __name__ == "__main__":
    main()
