"""Abstract base class for CLMM range strategies."""

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Optional, Tuple

import numpy as np
import pandas as pd


class BaseStrategy(ABC):
    """Base class that all CLMM range strategies must inherit from."""

    name: str = "base"

    @abstractmethod
    def calculate_range(
        self, current_price: float, historical_data: pd.DataFrame
    ) -> Tuple[float, float]:
        """Calculate the lower and upper price range for the LP position.

        Args:
            current_price: The current spot price.
            historical_data: DataFrame with columns [timestamp, open, high, low, close, volume]
                containing recent price history up to the current point.

        Returns:
            Tuple of (lower_price, upper_price).
        """
        ...

    def should_rebalance(
        self,
        current_price: float,
        lower: float,
        upper: float,
        last_rebalance_time: Optional[datetime],
        current_time: datetime,
        cooldown_hours: int = 6,
    ) -> bool:
        """Determine whether the position should be rebalanced.

        Default logic: rebalance when price exits the range and cooldown has elapsed.

        Args:
            current_price: Current spot price.
            lower: Current range lower bound.
            upper: Current range upper bound.
            last_rebalance_time: Timestamp of the last rebalance (None if never).
            current_time: Current timestamp.
            cooldown_hours: Minimum hours between rebalances.

        Returns:
            True if a rebalance should be triggered.
        """
        out_of_range = current_price < lower or current_price > upper

        if not out_of_range:
            return False

        if last_rebalance_time is not None:
            elapsed = (current_time - last_rebalance_time).total_seconds() / 3600
            if elapsed < cooldown_hours:
                return False

        return True

    def get_trend_bias(self, historical_data: pd.DataFrame) -> float:
        """Return an asymmetric shift ratio based on trend direction.

        A value of 0.5 means symmetric. A value of 0.6 means 60% of the range
        is above the current price (bullish bias).

        Default implementation uses EMA(7) vs EMA(21) crossover.

        Args:
            historical_data: DataFrame with at least a 'close' column.

        Returns:
            Float between 0.3 and 0.7 representing upper allocation ratio.
        """
        if len(historical_data) < 21:
            return 0.5

        close = historical_data["close"]
        ema7 = close.ewm(span=7, adjust=False).mean()
        ema21 = close.ewm(span=21, adjust=False).mean()

        latest_ema7 = ema7.iloc[-1]
        latest_ema21 = ema21.iloc[-1]

        if latest_ema21 == 0:
            return 0.5

        # Degree of crossover relative to price
        crossover_strength = (latest_ema7 - latest_ema21) / latest_ema21

        # Map to a bias between 0.35 and 0.65
        bias = 0.5 + np.clip(crossover_strength * 10, -0.15, 0.15)
        return float(bias)

    @staticmethod
    def _compute_atr(data: pd.DataFrame, period: int = 14) -> pd.Series:
        """Compute Average True Range.

        Args:
            data: DataFrame with high, low, close columns.
            period: ATR lookback period.

        Returns:
            Series of ATR values.
        """
        high = data["high"]
        low = data["low"]
        close = data["close"]

        prev_close = close.shift(1)
        tr = pd.concat(
            [
                (high - low),
                (high - prev_close).abs(),
                (low - prev_close).abs(),
            ],
            axis=1,
        ).max(axis=1)

        atr = tr.rolling(window=period, min_periods=1).mean()
        return atr
