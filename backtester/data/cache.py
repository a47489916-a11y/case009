"""Local CSV caching for fetched price data."""

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import pandas as pd

CACHE_DIR = Path(__file__).resolve().parent / "cache"


def _cache_path(token_pair: str, start_date: str, end_date: str) -> Path:
    """Deterministic file path for a given query."""
    safe_name = token_pair.replace("/", "_")
    filename = f"{safe_name}_{start_date}_{end_date}.csv"
    return CACHE_DIR / filename


def load_cache(
    token_pair: str,
    start_date: str,
    end_date: str,
    max_age_hours: float = 24.0,
) -> Optional[pd.DataFrame]:
    """Load cached OHLCV data if it exists and is fresh enough.

    Args:
        token_pair: e.g. "SOL/USDC".
        start_date: ISO date.
        end_date: ISO date.
        max_age_hours: Maximum cache age in hours before it is considered stale.

    Returns:
        DataFrame if a fresh cache exists, else None.
    """
    path = _cache_path(token_pair, start_date, end_date)
    if not path.exists():
        return None

    mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    age = datetime.now(timezone.utc) - mtime
    if age > timedelta(hours=max_age_hours):
        return None

    df = pd.read_csv(path, parse_dates=["timestamp"])
    return df


def save_cache(
    df: pd.DataFrame,
    token_pair: str,
    start_date: str,
    end_date: str,
) -> Path:
    """Save OHLCV data to the local CSV cache.

    Args:
        df: OHLCV DataFrame.
        token_pair: e.g. "SOL/USDC".
        start_date: ISO date.
        end_date: ISO date.

    Returns:
        Path to the saved file.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = _cache_path(token_pair, start_date, end_date)
    df.to_csv(path, index=False)
    return path


def get_or_fetch(
    token_pair: str,
    start_date: str,
    end_date: str,
    max_age_hours: float = 24.0,
) -> pd.DataFrame:
    """Load from cache or fetch from API, caching the result.

    Args:
        token_pair: e.g. "SOL/USDC".
        start_date: ISO date.
        end_date: ISO date.
        max_age_hours: Cache freshness threshold.

    Returns:
        OHLCV DataFrame.
    """
    cached = load_cache(token_pair, start_date, end_date, max_age_hours)
    if cached is not None:
        print(f"  [cache] Loaded {token_pair} from cache.")
        return cached

    # Import here to avoid circular imports
    from data.price_fetcher import fetch_price_data

    print(f"  [fetch] Fetching {token_pair} from CoinGecko...")
    df = fetch_price_data(token_pair, start_date, end_date)
    save_cache(df, token_pair, start_date, end_date)
    print(f"  [cache] Saved {token_pair} to cache.")
    return df
