/**
 * CLMM Manager Bot — Main Entry Point
 *
 * Concentrated Liquidity Market Maker manager for Solana and SUI.
 * Monitors positions, executes rebalances, and manages risk.
 *
 * Start with: npx tsx src/index.ts
 */

import { loadConfig } from './config.ts';
import { Engine } from './core/engine.ts';
import { getLogger, initLogger } from './utils/logger.ts';

async function main(): Promise<void> {
  // Temporary logger for startup
  const startupLogger = initLogger('info', './logs');
  startupLogger.info('CLMM Manager Bot starting...');

  // Load and validate configuration
  let config;
  try {
    config = loadConfig();
    startupLogger.info('Configuration loaded successfully', {
      strategy: config.strategy.type,
      pools: config.allocation.pools.length,
    });
  } catch (err) {
    startupLogger.error('Failed to load configuration', { error: (err as Error).message });
    process.exit(1);
  }

  // Create and initialize engine
  const engine = new Engine(config);

  try {
    await engine.initialize();
  } catch (err) {
    startupLogger.error('Failed to initialize engine', { error: (err as Error).message });
    process.exit(1);
  }

  // Handle graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    const logger = getLogger();
    logger.info(`Received ${signal}, shutting down gracefully...`);

    try {
      await engine.stop();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', { error: (err as Error).message });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('uncaughtException', (err) => {
    const logger = getLogger();
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    void shutdown('uncaughtException');
  });

  process.on('unhandledRejection', (reason) => {
    const logger = getLogger();
    logger.error('Unhandled rejection', { reason: String(reason) });
  });

  // Start the engine
  engine.start();
  getLogger().info('CLMM Manager Bot is running. Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
