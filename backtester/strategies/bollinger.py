"""Bollinger Band-based range strategy."""

from typing import Tuple

import numpy as np
import pandas as pd

from strategies.base import BaseStrategy


class BollingerStrategy(BaseStrategy):
    """Set LP range boundaries using Bollinger Bands (20-period, 2 sigma)."""

    name: str = "bollinger"

    def __init__(self, period: int = 20, num_std: float = 2.0):
        self.period = period
        self.num_std = num_std

    def calculate_range(
        self, current_price: float, historical_data: pd.DataFrame
    ) -> Tuple[float, float]:
        close = historical_data["close"]

        if len(close) < self.period:
            # Fallback to fixed 10%
            half = current_price * 0.10
            return (current_price - half, current_price + half)

        sma = close.rolling(window=self.period).mean().iloc[-1]
        std = close.rolling(window=self.period).std().iloc[-1]

        raw_upper = sma + self.num_std * std
        raw_lower = sma - self.num_std * std

        # Apply trend bias to shift the band
        bias = self.get_trend_bias(historical_data)
        band_width = raw_upper - raw_lower

        center = current_price
        upper = center + band_width * bias
        lower = center - band_width * (1 - bias)

        # Clamp: range must be at least 2% wide and lower > 0
        min_half = current_price * 0.01
        if upper - current_price < min_half:
            upper = current_price + min_half
        if current_price - lower < min_half:
            lower = current_price - min_half

        lower = max(lower, current_price * 0.01)
        return (lower, upper)
