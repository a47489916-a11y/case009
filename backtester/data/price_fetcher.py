"""Fetch historical OHLCV price data from CoinGecko free API."""

import time
from datetime import datetime, timezone
from typing import Optional

import pandas as pd
import requests

from config import COINGECKO_IDS

BASE_URL = "https://api.coingecko.com/api/v3"

# CoinGecko free tier: ~10-30 requests/minute
_REQUEST_INTERVAL = 4.0  # seconds between requests (safe for free tier)
_last_request_time: float = 0.0


def _rate_limit() -> None:
    """Block until the minimum interval has elapsed since the last request."""
    global _last_request_time
    now = time.time()
    wait = _REQUEST_INTERVAL - (now - _last_request_time)
    if wait > 0:
        time.sleep(wait)
    _last_request_time = time.time()


def fetch_ohlcv(
    token: str,
    vs_currency: str = "usd",
    start_date: str = "2024-01-01",
    end_date: str = "2024-12-31",
) -> pd.DataFrame:
    """Fetch daily OHLCV data from CoinGecko.

    CoinGecko's /coins/{id}/ohlc endpoint returns [timestamp, open, high, low, close].
    Volume is fetched separately from /coins/{id}/market_chart/range.

    Args:
        token: Token symbol (e.g. "SOL", "SUI").
        vs_currency: Quote currency for CoinGecko (default "usd").
        start_date: ISO date string.
        end_date: ISO date string.

    Returns:
        DataFrame with columns: timestamp, open, high, low, close, volume.
    """
    coin_id = COINGECKO_IDS.get(token.upper())
    if coin_id is None:
        raise ValueError(
            f"Unknown token '{token}'. Add it to COINGECKO_IDS in config.py. "
            f"Known tokens: {list(COINGECKO_IDS.keys())}"
        )

    start_ts = int(datetime.fromisoformat(start_date).replace(tzinfo=timezone.utc).timestamp())
    end_ts = int(datetime.fromisoformat(end_date).replace(tzinfo=timezone.utc).timestamp())

    # --- Fetch OHLC ---
    # CoinGecko OHLC: days param determines granularity.
    # >30 days -> 4-day candles (max_days=365 gives ~90 candles)
    # We'll use market_chart/range for better granularity.
    _rate_limit()
    mc_url = f"{BASE_URL}/coins/{coin_id}/market_chart/range"
    mc_params = {
        "vs_currency": vs_currency,
        "from": start_ts,
        "to": end_ts,
    }
    resp = requests.get(mc_url, params=mc_params, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    prices = data.get("prices", [])
    volumes = data.get("total_volumes", [])

    if not prices:
        raise ValueError(f"No price data returned for {token} ({coin_id}).")

    # Build a DataFrame from the market_chart data (gives close prices)
    df_prices = pd.DataFrame(prices, columns=["timestamp_ms", "close"])
    df_prices["timestamp"] = pd.to_datetime(df_prices["timestamp_ms"], unit="ms", utc=True)

    df_vol = pd.DataFrame(volumes, columns=["timestamp_ms", "volume"])
    df_vol["timestamp"] = pd.to_datetime(df_vol["timestamp_ms"], unit="ms", utc=True)

    # Resample to daily OHLCV
    df_prices = df_prices.set_index("timestamp").resample("1D").agg(
        {"close": ["first", "max", "min", "last"]}
    )
    df_prices.columns = ["open", "high", "low", "close"]
    df_prices = df_prices.dropna()

    df_vol = df_vol.set_index("timestamp").resample("1D").agg({"volume": "sum"})

    df = df_prices.join(df_vol, how="left").fillna(0)
    df = df.reset_index()
    df = df.rename(columns={"timestamp": "timestamp"})

    # Ensure high >= open/close and low <= open/close
    df["high"] = df[["open", "high", "close"]].max(axis=1)
    df["low"] = df[["open", "low", "close"]].min(axis=1)

    return df


def fetch_price_data(
    token_pair: str,
    start_date: str,
    end_date: str,
) -> pd.DataFrame:
    """Convenience wrapper that parses a token pair string.

    Args:
        token_pair: e.g. "SOL/USDC"
        start_date: ISO date.
        end_date: ISO date.

    Returns:
        Daily OHLCV DataFrame.
    """
    base = token_pair.split("/")[0]
    # CoinGecko always prices against USD; USDC ~ 1 USD so this is fine.
    return fetch_ohlcv(base, vs_currency="usd", start_date=start_date, end_date=end_date)
