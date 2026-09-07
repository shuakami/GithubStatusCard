// @ts-check

import { logger } from "./log.js";

// Hard ceiling for serving stale entries after upstream failures.
const MAX_STALE_TTL_SECONDS = 30 * 24 * 60 * 60;

let sqlClient = null;
let tableReadyPromise = null;

/**
 * Lazily create the Neon SQL client. Returns null when no database is
 * configured so the card keeps working without a cache backend.
 *
 * @returns {Promise<any>} Neon sql tagged-template client, or null.
 */
const getSqlClient = async () => {
  if (!process.env.DATABASE_URL || process.env.NODE_ENV === "test") {
    return null;
  }
  if (!sqlClient) {
    const { neon } = await import("@neondatabase/serverless");
    sqlClient = neon(process.env.DATABASE_URL);
  }
  return sqlClient;
};

/**
 * Create the cache table once per client lifetime.
 *
 * @param {any} sql Neon sql tagged-template client.
 * @returns {Promise<void>} Resolves when the table exists.
 */
const ensureTable = async (sql) => {
  if (!tableReadyPromise) {
    tableReadyPromise = sql`
      CREATE TABLE IF NOT EXISTS stats_cache (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.catch((err) => {
      tableReadyPromise = null;
      throw err;
    });
  }
  return tableReadyPromise;
};

/**
 * Read a cache entry with its age in seconds.
 *
 * @param {string} key Cache key.
 * @returns {Promise<{ value: any, age: number } | null>} Entry and age, or null.
 */
const readCacheEntry = async (key) => {
  try {
    const sql = await getSqlClient();
    if (!sql) {
      return null;
    }
    await ensureTable(sql);
    const rows = await sql`
      SELECT value, EXTRACT(EPOCH FROM (now() - updated_at)) AS age
      FROM stats_cache
      WHERE key = ${key}
    `;
    if (!rows.length) {
      return null;
    }
    return { value: rows[0].value, age: Number(rows[0].age) };
  } catch (err) {
    logger.log(`cache read failed for ${key}: ${err}`);
    return null;
  }
};

/**
 * Upsert a cache entry. Failures are logged and never break rendering.
 *
 * @param {string} key Cache key.
 * @param {any} value Serializable value.
 * @returns {Promise<void>} Resolves when written (or skipped/failed).
 */
const writeCacheEntry = async (key, value) => {
  try {
    const sql = await getSqlClient();
    if (!sql) {
      return;
    }
    await ensureTable(sql);
    await sql`
      INSERT INTO stats_cache (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}::jsonb, now())
      ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = now()
    `;
  } catch (err) {
    logger.log(`cache write failed for ${key}: ${err}`);
  }
};

export { readCacheEntry, writeCacheEntry, MAX_STALE_TTL_SECONDS };
