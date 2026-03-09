/**
 * Core type definitions for the CLMM Manager Bot.
 */

/** Supported blockchain networks. */
export type Chain = 'solana' | 'sui';

/** Supported DEX protocols. */
export type Dex = 'orca' | 'raydium' | 'cetus';

/** Position health status relative to its price range. */
export type PositionStatus = 'in_range' | 'near_boundary' | 'out_of_range';

/** Market volatility regime classification. */
export interface MarketRegime {
  regime: 'low_vol' | 'normal' | 'high_vol' | 'extreme';
  /** Ratio of current ATR to 90-day average ATR. */
  atrRatio: number;
}

/** Strategy selection for range calculation. */
export type StrategyType = 'volatility_2sigma' | 'fixed_pct' | 'bollinger';

/** Represents an active CLMM position. */
export interface Position {
  id: string;
  chain: Chain;
  dex: Dex;
  pool: string;
  tokenA: string;
  tokenB: string;
  lowerPrice: number;
  upperPrice: number;
  liquidity: bigint;
  depositedValueUsd: number;
  currentValueUsd: number;
  feesEarnedUsd: number;
  openedAt: Date;
  lastRebalanceAt: Date;
}

/** Serializable version of Position for DB storage. */
export interface PositionRow {
  id: string;
  chain: string;
  dex: string;
  pool: string;
  token_a: string;
  token_b: string;
  lower_price: number;
  upper_price: number;
  liquidity: string;
  deposited_value_usd: number;
  current_value_usd: number;
  fees_earned_usd: number;
  opened_at: string;
  last_rebalance_at: string;
}

/** Describes a rebalance that was executed or planned. */
export interface RebalanceAction {
  positionId: string;
  reason: string;
  oldRange: [number, number];
  newRange: [number, number];
  estimatedCost: number;
  timestamp: Date;
}

/** Serializable version of RebalanceAction for DB storage. */
export interface RebalanceRow {
  id: number;
  position_id: string;
  reason: string;
  old_lower: number;
  old_upper: number;
  new_lower: number;
  new_upper: number;
  estimated_cost: number;
  timestamp: string;
}

/** Impermanent loss snapshot for a position. */
export interface ILSnapshot {
  positionId: string;
  timestamp: Date;
  positionValueUsd: number;
  hodlValueUsd: number;
  ilPct: number;
  ilUsd: number;
}

/** Price data for a token. */
export interface PriceData {
  symbol: string;
  price: number;
  confidence: number;
  timestamp: Date;
  source: 'pyth' | 'coingecko' | 'dex';
}

/** Gas/transaction cost estimate. */
export interface GasEstimate {
  chain: Chain;
  baseFee: number;
  priorityFee: number;
  totalLamportsOrMist: bigint;
  totalUsd: number;
}

/** Pool allocation configuration entry. */
export interface PoolAllocation {
  pool: string;
  chain: string;
  dex: string;
  weight: number;
}

/** Result of monitoring a single position. */
export interface MonitorResult {
  position: Position;
  status: PositionStatus;
  currentPrice: number;
  distanceToBoundaryPct: number;
  regime: MarketRegime;
}

/** Daily summary statistics. */
export interface DailySummary {
  date: string;
  totalValueUsd: number;
  totalFeesUsd: number;
  totalIlUsd: number;
  rebalanceCount: number;
  positions: Array<{
    id: string;
    pool: string;
    status: PositionStatus;
    valueUsd: number;
    feesUsd: number;
    ilPct: number;
  }>;
}

/** Discord notification severity. */
export type NotificationLevel = 'info' | 'warning' | 'critical';

/** Cryptact CSV row for tax export. */
export interface CryptactRow {
  Timestamp: string;
  Action: 'BUY' | 'SELL' | 'BONUS' | 'LOSS';
  Source: string;
  Base: string;
  Volume: string;
  Price: string;
  Counter: string;
  Fee: string;
  FeeCcy: string;
  Comment: string;
}

/**
 * Common interface for all CLMM DEX adapters.
 * Each chain/dex combination implements this interface.
 */
export interface CLMMAdapter {
  readonly chain: Chain;
  readonly dex: Dex;

  /** Fetch current positions from the on-chain program. */
  getPositions(): Promise<Position[]>;

  /** Get the current pool price for a given pool address or pair. */
  getPoolPrice(pool: string): Promise<number>;

  /** Collect accrued fees from a position. */
  collectFees(positionId: string): Promise<{ tokenAAmount: bigint; tokenBAmount: bigint }>;

  /** Close an existing position, withdrawing all liquidity. */
  closePosition(positionId: string): Promise<{ tokenAAmount: bigint; tokenBAmount: bigint }>;

  /** Open a new position with given parameters. */
  openPosition(params: {
    pool: string;
    lowerPrice: number;
    upperPrice: number;
    tokenAAmount: bigint;
    tokenBAmount: bigint;
  }): Promise<Position>;

  /** Simulate a transaction before execution. Returns success flag and estimated cost. */
  simulateRebalance(params: {
    positionId: string;
    newLowerPrice: number;
    newUpperPrice: number;
  }): Promise<{ success: boolean; estimatedCost: number; error?: string }>;
}

/**
 * Common interface for token swap adapters.
 */
export interface SwapAdapter {
  readonly chain: Chain;

  /** Get a swap quote. */
  getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }): Promise<{ expectedOutput: bigint; priceImpactPct: number; fee: bigint }>;

  /** Execute a token swap. */
  executeSwap(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
    minOutput: bigint;
  }): Promise<{ txHash: string; actualOutput: bigint }>;
}

/** Strategy interface for computing position ranges. */
export interface RangeStrategy {
  readonly name: StrategyType;

  /** Calculate the optimal price range for a position. */
  calculateRange(params: {
    currentPrice: number;
    prices: number[];
    regime: MarketRegime;
  }): { lower: number; upper: number };
}

/** Configuration for the application (validated shape). */
export interface AppConfig {
  solana: {
    rpcUrl: string;
    walletPath: string;
  };
  sui: {
    rpcUrl: string;
    walletPath: string;
  };
  strategy: {
    type: StrategyType;
    params: Record<string, number>;
  };
  risk: {
    maxRebalancesPerDay: number;
    cooldownHours: number;
    circuitBreaker24hPct: number;
    maxSlippageBps: number;
    oracleDeviationPct: number;
    minWaitHoursOutOfRange: number;
    maxWaitHoursOutOfRange: number;
    costToFeeThreshold: number;
  };
  allocation: {
    pools: PoolAllocation[];
    usdcReservePct: number;
  };
  notifications: {
    discordWebhookUrl: string;
  };
  tax: {
    outputDir: string;
    baseCurrency: string;
  };
  monitoring: {
    intervalMs: number;
    nearBoundaryPct: number;
  };
  database: {
    path: string;
  };
  logging: {
    level: string;
    dir: string;
  };
  priceFeed: {
    pythEndpoint: string;
    coingeckoApiKey: string;
    cacheTtlMs: number;
  };
}
