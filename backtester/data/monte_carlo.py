"""Monte Carlo price path generation using Geometric Brownian Motion (GBM)."""

from typing import Optional

import numpy as np
import pandas as pd


def generate_gbm_paths(
    s0: float,
    mu: float,
    sigma: float,
    num_steps: int,
    num_paths: int = 1000,
    dt: float = 1.0 / 365,
    seed: Optional[int] = None,
) -> np.ndarray:
    """Generate synthetic price paths via Geometric Brownian Motion.

    dS = mu * S * dt + sigma * S * dW

    Args:
        s0: Initial price.
        mu: Annualised drift (e.g. 0.0 for no drift, 0.5 for 50% annual growth).
        sigma: Annualised volatility (e.g. 0.8 for 80%).
        num_steps: Number of time steps (e.g. 365 for one year of daily data).
        num_paths: Number of independent paths to simulate.
        dt: Time step size in years (1/365 for daily).
        seed: Random seed for reproducibility.

    Returns:
        np.ndarray of shape (num_paths, num_steps + 1) with price paths.
        Column 0 is the initial price for every path.
    """
    rng = np.random.default_rng(seed)

    # Pre-compute drift and diffusion per step
    drift = (mu - 0.5 * sigma**2) * dt
    diffusion = sigma * np.sqrt(dt)

    # Generate random increments: Z ~ N(0,1)
    z = rng.standard_normal((num_paths, num_steps))

    # Log returns
    log_returns = drift + diffusion * z

    # Cumulative sum of log returns, prepend 0 for initial price
    log_paths = np.concatenate(
        [np.zeros((num_paths, 1)), np.cumsum(log_returns, axis=1)], axis=1
    )

    paths = s0 * np.exp(log_paths)
    return paths


def paths_to_ohlcv(
    paths: np.ndarray,
    start_date: str = "2024-01-01",
    base_volume: float = 1e8,
) -> list[pd.DataFrame]:
    """Convert GBM price paths into OHLCV DataFrames.

    Each path becomes a DataFrame mimicking daily candles.  Since GBM gives
    close-to-close prices, we synthesise open/high/low by adding small intraday
    noise.

    Args:
        paths: Array of shape (num_paths, num_steps+1).
        start_date: Start date for the timestamp index.
        base_volume: Average daily volume in USD.

    Returns:
        List of DataFrames, one per path.
    """
    rng = np.random.default_rng(42)
    num_paths, length = paths.shape
    dates = pd.date_range(start=start_date, periods=length, freq="D")

    results: list[pd.DataFrame] = []
    for i in range(num_paths):
        close = paths[i]
        # Open = previous close (with small gap noise)
        open_ = np.roll(close, 1)
        open_[0] = close[0]

        # High/low: random intraday range
        intraday_range = np.abs(rng.normal(0, 0.02, size=length)) * close
        high = np.maximum(open_, close) + intraday_range * 0.5
        low = np.minimum(open_, close) - intraday_range * 0.5
        low = np.maximum(low, close * 0.001)  # floor at near-zero

        volume = base_volume * (1 + rng.normal(0, 0.3, size=length))
        volume = np.maximum(volume, 0)

        df = pd.DataFrame(
            {
                "timestamp": dates,
                "open": open_,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
            }
        )
        results.append(df)

    return results


def generate_ohlcv(
    s0: float = 100.0,
    mu: float = 0.0,
    sigma: float = 0.8,
    num_days: int = 365,
    num_paths: int = 1,
    start_date: str = "2024-01-01",
    seed: Optional[int] = None,
) -> list[pd.DataFrame]:
    """High-level helper: generate OHLCV DataFrames from GBM parameters.

    Args:
        s0: Initial price.
        mu: Annualised drift.
        sigma: Annualised volatility.
        num_days: Number of trading days.
        num_paths: Number of paths.
        start_date: ISO date string for the first day.
        seed: Random seed.

    Returns:
        List of OHLCV DataFrames.
    """
    paths = generate_gbm_paths(s0, mu, sigma, num_days, num_paths, seed=seed)
    return paths_to_ohlcv(paths, start_date=start_date)
