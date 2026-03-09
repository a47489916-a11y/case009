/**
 * Winston logger setup with console + daily rotating file output.
 */

import { createLogger, format, transports, type Logger } from 'winston';
import { mkdirSync } from 'node:fs';

let _logger: Logger | null = null;

/**
 * Initialize the global logger instance.
 * @param level Log level (default: 'info')
 * @param logDir Directory for log files (default: './logs')
 */
export function initLogger(level = 'info', logDir = './logs'): Logger {
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  const logFormat = format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.errors({ stack: true }),
    format.json()
  );

  const consoleFormat = format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.colorize(),
    format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
      return `${timestamp as string} [${level}] ${message as string}${metaStr}`;
    })
  );

  _logger = createLogger({
    level,
    format: logFormat,
    defaultMeta: { service: 'clmm-manager' },
    transports: [
      new transports.Console({
        format: consoleFormat,
      }),
      new transports.File({
        filename: `${logDir}/error.log`,
        level: 'error',
        maxsize: 10 * 1024 * 1024, // 10MB
        maxFiles: 30,
      }),
      new transports.File({
        filename: `${logDir}/combined.log`,
        maxsize: 10 * 1024 * 1024,
        maxFiles: 30,
      }),
    ],
  });

  return _logger;
}

/**
 * Get the global logger instance. Initializes with defaults if not yet created.
 */
export function getLogger(): Logger {
  if (!_logger) {
    _logger = initLogger();
  }
  return _logger;
}
