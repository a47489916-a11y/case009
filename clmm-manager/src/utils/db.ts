/**
 * SQLite database wrapper using sql.js (pure JS SQLite).
 * Auto-creates tables on first run.
 */

import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getLogger } from './logger.ts';
import type { PositionRow, RebalanceRow } from '../core/types.ts';

let _db: SqlJsDatabase | null = null;
let _dbPath: string | null = null;

const CREATE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS positions (
    id TEXT PRIMARY KEY,
    chain TEXT NOT NULL,
    dex TEXT NOT NULL,
    pool TEXT NOT NULL,
    token_a TEXT NOT NULL,
    token_b TEXT NOT NULL,
    lower_price REAL NOT NULL,
    upper_price REAL NOT NULL,
    liquidity TEXT NOT NULL,
    deposited_value_usd REAL NOT NULL DEFAULT 0,
    current_value_usd REAL NOT NULL DEFAULT 0,
    fees_earned_usd REAL NOT NULL DEFAULT 0,
    opened_at TEXT NOT NULL,
    last_rebalance_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rebalance_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    old_lower REAL NOT NULL,
    old_upper REAL NOT NULL,
    new_lower REAL NOT NULL,
    new_upper REAL NOT NULL,
    estimated_cost REAL NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS il_tracking (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    position_value_usd REAL NOT NULL,
    hodl_value_usd REAL NOT NULL,
    il_pct REAL NOT NULL,
    il_usd REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fee_collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    token_a_amount TEXT NOT NULL,
    token_b_amount TEXT NOT NULL,
    total_usd REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    total_value_usd REAL NOT NULL,
    total_fees_usd REAL NOT NULL,
    total_il_usd REAL NOT NULL,
    rebalance_count INTEGER NOT NULL DEFAULT 0,
    positions_json TEXT NOT NULL
  );
`;

/**
 * Persist the database to disk.
 */
function persist(): void {
  if (_db && _dbPath) {
    try {
      const data = _db.export();
      writeFileSync(_dbPath, Buffer.from(data));
    } catch {
      // Non-critical; in-memory state is still valid
    }
  }
}

/**
 * Initialize the database, creating tables if they don't exist.
 */
export async function initDatabase(dbPath: string): Promise<SqlJsDatabase> {
  const logger = getLogger();

  try {
    mkdirSync(dirname(dbPath), { recursive: true });
  } catch {
    // Directory may already exist
  }

  const SQL = await initSqlJs();

  let db: SqlJsDatabase;
  if (existsSync(dbPath)) {
    const fileBuffer = readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(CREATE_TABLES_SQL);

  _db = db;
  _dbPath = dbPath;
  persist();

  logger.info('Database initialized', { path: dbPath });
  return db;
}

/**
 * Initialize the database synchronously for testing (uses in-memory DB).
 */
export function initDatabaseSync(SQL: { Database: new (data?: ArrayLike<number>) => SqlJsDatabase }): SqlJsDatabase {
  const db = new SQL.Database();
  db.run(CREATE_TABLES_SQL);
  _db = db;
  _dbPath = null;
  return db;
}

/** Get the global database instance. */
export function getDb(): SqlJsDatabase {
  if (!_db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return _db;
}

/** Close the database connection gracefully. */
export function closeDatabase(): void {
  if (_db) {
    persist();
    _db.close();
    _db = null;
    _dbPath = null;
  }
}

// ---------- Helper to run queries ----------

function runQuery(sql: string, params: Record<string, unknown> = {}): void {
  const db = getDb();
  // Convert named params to positional for sql.js
  const paramEntries = Object.entries(params);
  const bindParams: Record<string, unknown> = {};
  for (const [key, value] of paramEntries) {
    bindParams[`:${key}`] = value;
  }
  db.run(sql.replace(/@(\w+)/g, ':$1'), bindParams);
  persist();
}

function queryAll<T>(sql: string, params: unknown[] = []): T[] {
  const db = getDb();
  const stmt = db.prepare(sql);
  if (params.length > 0) {
    stmt.bind(params);
  }
  const results: T[] = [];
  while (stmt.step()) {
    const row = stmt.getAsObject() as T;
    results.push(row);
  }
  stmt.free();
  return results;
}

function queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
  const results = queryAll<T>(sql, params);
  return results[0];
}

// ---------- Position operations ----------

/** Upsert a position record. */
export function upsertPosition(pos: PositionRow): void {
  runQuery(`
    INSERT OR REPLACE INTO positions (id, chain, dex, pool, token_a, token_b, lower_price, upper_price,
      liquidity, deposited_value_usd, current_value_usd, fees_earned_usd, opened_at, last_rebalance_at)
    VALUES (@id, @chain, @dex, @pool, @token_a, @token_b, @lower_price, @upper_price,
      @liquidity, @deposited_value_usd, @current_value_usd, @fees_earned_usd, @opened_at, @last_rebalance_at)
  `, pos as unknown as Record<string, unknown>);
}

/** Get all positions. */
export function getAllPositions(): PositionRow[] {
  return queryAll<PositionRow>('SELECT * FROM positions');
}

/** Get a position by ID. */
export function getPositionById(id: string): PositionRow | undefined {
  return queryOne<PositionRow>('SELECT * FROM positions WHERE id = ?', [id]);
}

/** Delete a position by ID. */
export function deletePosition(id: string): void {
  const db = getDb();
  db.run('DELETE FROM positions WHERE id = ?', [id]);
  persist();
}

// ---------- Rebalance history operations ----------

/** Insert a rebalance history record. */
export function insertRebalance(rebalance: Omit<RebalanceRow, 'id'>): void {
  runQuery(`
    INSERT INTO rebalance_history (position_id, reason, old_lower, old_upper, new_lower, new_upper, estimated_cost, timestamp)
    VALUES (@position_id, @reason, @old_lower, @old_upper, @new_lower, @new_upper, @estimated_cost, @timestamp)
  `, rebalance as unknown as Record<string, unknown>);
}

/** Get rebalance count for today (UTC). */
export function getTodayRebalanceCount(): number {
  const today = new Date().toISOString().slice(0, 10);
  const row = queryOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM rebalance_history WHERE timestamp >= ?",
    [today + 'T00:00:00.000Z']
  );
  return row?.count ?? 0;
}

/** Get the last rebalance time for a position. */
export function getLastRebalanceTime(positionId: string): Date | null {
  const row = queryOne<{ timestamp: string }>(
    'SELECT timestamp FROM rebalance_history WHERE position_id = ? ORDER BY timestamp DESC LIMIT 1',
    [positionId]
  );
  return row ? new Date(row.timestamp) : null;
}

/** Get recent rebalances within a time window. */
export function getRecentRebalances(sinceHours: number): RebalanceRow[] {
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();
  return queryAll<RebalanceRow>(
    'SELECT * FROM rebalance_history WHERE timestamp >= ? ORDER BY timestamp DESC',
    [since]
  );
}

// ---------- IL tracking operations ----------

/** Insert an IL snapshot. */
export function insertILSnapshot(snapshot: {
  position_id: string;
  timestamp: string;
  position_value_usd: number;
  hodl_value_usd: number;
  il_pct: number;
  il_usd: number;
}): void {
  runQuery(`
    INSERT INTO il_tracking (position_id, timestamp, position_value_usd, hodl_value_usd, il_pct, il_usd)
    VALUES (@position_id, @timestamp, @position_value_usd, @hodl_value_usd, @il_pct, @il_usd)
  `, snapshot as unknown as Record<string, unknown>);
}

/** Get IL history for a position. */
export function getILHistory(positionId: string): Array<{
  timestamp: string;
  position_value_usd: number;
  hodl_value_usd: number;
  il_pct: number;
  il_usd: number;
}> {
  return queryAll(
    'SELECT timestamp, position_value_usd, hodl_value_usd, il_pct, il_usd FROM il_tracking WHERE position_id = ? ORDER BY timestamp',
    [positionId]
  );
}

/** Get cumulative IL across all positions. */
export function getCumulativeIL(): number {
  const row = queryOne<{ total: number }>(`
    SELECT COALESCE(SUM(latest_il), 0) as total FROM (
      SELECT il_usd as latest_il
      FROM il_tracking
      WHERE id IN (
        SELECT MAX(id) FROM il_tracking GROUP BY position_id
      )
    )
  `);
  return row?.total ?? 0;
}

// ---------- Fee collection operations ----------

/** Insert a fee collection record. */
export function insertFeeCollection(record: {
  position_id: string;
  timestamp: string;
  token_a_amount: string;
  token_b_amount: string;
  total_usd: number;
}): void {
  runQuery(`
    INSERT INTO fee_collections (position_id, timestamp, token_a_amount, token_b_amount, total_usd)
    VALUES (@position_id, @timestamp, @token_a_amount, @token_b_amount, @total_usd)
  `, record as unknown as Record<string, unknown>);
}

// ---------- Daily snapshot operations ----------

/** Upsert a daily snapshot. */
export function upsertDailySnapshot(snapshot: {
  date: string;
  total_value_usd: number;
  total_fees_usd: number;
  total_il_usd: number;
  rebalance_count: number;
  positions_json: string;
}): void {
  // Delete then insert to simulate upsert (sql.js doesn't support ON CONFLICT well with all cases)
  const db = getDb();
  db.run('DELETE FROM daily_snapshots WHERE date = ?', [snapshot.date]);
  runQuery(`
    INSERT INTO daily_snapshots (date, total_value_usd, total_fees_usd, total_il_usd, rebalance_count, positions_json)
    VALUES (@date, @total_value_usd, @total_fees_usd, @total_il_usd, @rebalance_count, @positions_json)
  `, snapshot as unknown as Record<string, unknown>);
}
