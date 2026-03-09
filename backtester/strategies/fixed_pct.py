"""Fixed percentage range strategy -- baseline comparison."""

from typing import Tuple

import pandas as pd

from strategies.base import BaseStrategy


class FixedPercentageStrategy(BaseStrategy):
    """Place a symmetric range of +/- pct around current price."""

    name: str = "fixed_pct"

    def __init__(self, pct: float = 0.10):
        """
        Args:
            pct: Half-width of the range as a decimal (0.10 = +/-10%).
        """
        self.pct = pct
        self.name = f"fixed_{int(pct * 100)}pct"

    def calculate_range(
        self, current_price: float, historical_data: pd.DataFrame
    ) -> Tuple[float, float]:
        bias = self.get_trend_bias(historical_data)
        total_width = current_price * self.pct * 2

        upper = current_price + total_width * bias
        lower = current_price - total_width * (1 - bias)

        return (max(lower, current_price * 0.01), upper)
