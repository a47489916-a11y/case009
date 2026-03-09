"""ATR-based 2-sigma volatility-linked range strategy (RECOMMENDED)."""

import math
from typing import Optional, Tuple

import numpy as np
import pandas as pd

from strategies.base import BaseStrategy


# Token-specific regime thresholds
TOKEN_REGIMES = {
    "SOL": {
        "low": (0.05, 0.08),
        "normal": (0.10, 0.12),
        "high": (0.15, 0.20),
    },
    "SUI": {
        "low": (0.07, 0.10),
        "normal": (0.14, 0.18),
        "high": (0.20, 0.25),
    },
}

# Fallback for tokens not explicitly listed
DEFAULT_REGIMES = {
    "low": (0.05, 0.10),
    "normal": (0.10, 0.15),
    "high": (0.15, 0.25),
}


class Volatility2SigmaStrategy(BaseStrategy):
    """
    Range width = ATR(14) * 2.0 * sqrt(holding_days), clamped to [2%, 30%].

    Market regime detection:
      - Low vol   (ATR < avg*0.7):  tighter range
      - Normal:                      standard range
      - High vol  (ATR > avg*1.5):  wider range
      - Extreme   (3-sigma event):  close position (returns None-like signal)

    Trend bias via EMA(7) vs EMA(21) crossover.
    """

    name: str = "volatility_2sigma"

    def __init__(
        self,
        atr_period: int = 14,
        multiplier: float = 2.0,
        holding_days: float = 1.0,
        min_range_pct: float = 0.02,
        max_range_pct: float = 0.30,
        token: str = "SOL",
    ):
        self.atr_period = atr_period
        self.multiplier = multiplier
        self.holding_days = holding_days
        self.min_range_pct = min_range_pct
        self.max_range_pct = max_range_pct
        self.token = token.upper()
        self.regimes = TOKEN_REGIMES.get(self.token, DEFAULT_REGIMES)

    def _detect_regime(
        self, current_atr: float, avg_atr: float, current_price: float, std_atr: float
    ) -> str:
        """Classify the current volatility regime."""
        if current_atr > avg_atr + 3 * std_atr:
            return "extreme"
        if current_atr > avg_atr * 1.5:
            return "high"
        if current_atr < avg_atr * 0.7:
            return "low"
        return "normal"

    def calculate_range(
        self, current_price: float, historical_data: pd.DataFrame
    ) -> Tuple[float, float]:
        """Compute the LP range using ATR-based volatility scaling.

        Returns:
            (lower, upper) price bounds.  When an extreme 3-sigma event is
            detected the range is set extremely tight (essentially signalling
            the caller to close the position).
        """
        atr_series = self._compute_atr(historical_data, self.atr_period)

        if len(atr_series) < self.atr_period:
            # Not enough data -- fall back to a conservative 10% range
            half = current_price * 0.10
            return (current_price - half, current_price + half)

        current_atr = float(atr_series.iloc[-1])
        avg_atr = float(atr_series.mean())
        std_atr = float(atr_series.std()) if len(atr_series) > 1 else avg_atr * 0.3

        regime = self._detect_regime(current_atr, avg_atr, current_price, std_atr)

        if regime == "extreme":
            # Signal to close -- return a tiny range that will immediately
            # trigger an out-of-range condition on any movement.
            epsilon = current_price * 0.001
            return (current_price - epsilon, current_price + epsilon)

        # Base range width from ATR
        raw_pct = (current_atr / current_price) * self.multiplier * math.sqrt(
            max(self.holding_days, 0.1)
        )

        # Clamp to regime-specific bounds
        regime_bounds = self.regimes[regime]
        half_pct = float(np.clip(raw_pct, regime_bounds[0], regime_bounds[1]))

        # Also enforce global min/max
        half_pct = float(np.clip(half_pct, self.min_range_pct, self.max_range_pct))

        # Apply trend bias
        bias = self.get_trend_bias(historical_data)
        total_width = current_price * half_pct * 2

        upper = current_price + total_width * bias
        lower = current_price - total_width * (1 - bias)

        return (max(lower, current_price * 0.01), upper)

    def should_rebalance(
        self,
        current_price: float,
        lower: float,
        upper: float,
        last_rebalance_time=None,
        current_time=None,
        cooldown_hours: int = 6,
    ) -> bool:
        """Override to also trigger rebalance when range is extremely tight
        (extreme regime signal)."""
        range_width_pct = (upper - lower) / current_price if current_price else 0

        # Extreme regime: tiny range signals "close position"
        if range_width_pct < 0.005:
            return True

        return super().should_rebalance(
            current_price, lower, upper, last_rebalance_time, current_time, cooldown_hours
        )
