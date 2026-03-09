"""Backtest configuration."""

from dataclasses import dataclass, field
from typing import List


@dataclass
class BacktestConfig:
    """Configuration for a CLMM backtest run."""

    token_pair: str = "SOL/USDC"
    initial_capital: float = 50_000.0
    start_date: str = "2024-01-01"
    end_date: str = "2024-12-31"
    fee_tier: float = 0.003  # 0.3%
    rebalance_cooldown_hours: int = 6
    max_rebalances_per_day: int = 6
    slippage_bps: int = 50  # 0.5%
    swap_fee_bps: int = 30  # 0.3%
    gas_cost_usd: float = 0.01
    volume_multiplier: float = 1.0  # Proxy for relative volume scaling
    holding_days: float = 1.0  # Holding period for range width scaling

    @property
    def slippage_pct(self) -> float:
        return self.slippage_bps / 10_000

    @property
    def swap_fee_pct(self) -> float:
        return self.swap_fee_bps / 10_000

    @property
    def base_token(self) -> str:
        return self.token_pair.split("/")[0]

    @property
    def quote_token(self) -> str:
        return self.token_pair.split("/")[1]


# Mapping of token symbols to CoinGecko IDs
COINGECKO_IDS = {
    "SOL": "solana",
    "SUI": "sui",
    "MSOL": "msol",
    "mSOL": "msol",
    "USDC": "usd-coin",
    "USDT": "tether",
    "ETH": "ethereum",
    "BTC": "bitcoin",
}
