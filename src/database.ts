/**
 * Stores and retrieves monitored products and availability states using SQLite.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 * Updated: 2026-07-25
 */

import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";

// Creates the data directory if it does not already exist.
mkdirSync("data", { recursive: true });

// Opens the database file or creates it on the first execution.
const database = new Database("data/availability-watcher.db");

// Enables relationships between SQLite tables for this connection.
database.pragma("foreign_keys = ON");

// Creates the required tables only when they do not already exist.
database.exec(`
  CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    product_code TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (source, product_code)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS availability_status (
    watch_id INTEGER PRIMARY KEY,
    is_available INTEGER NOT NULL CHECK (is_available IN (0, 1)),
    last_checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (watch_id)
      REFERENCES watches (id)
      ON DELETE CASCADE
  ) STRICT;
`);

interface WatchRow {
  id: number;
}

interface WatchedProductRow {
  product_code: string;
}

interface AvailabilityRow {
  is_available: number;
}

interface WatchlistItemRow {
  product_code: string;
  is_available: number | null;
  last_checked_at: string | null;
}

export interface WatchlistItem {
  productCode: string;
  isAvailable: boolean | undefined;
  lastCheckedAt: string | undefined;
}

/**
 * Adds a product to the watchlist.
 * Returns false when the product is already being monitored.
 */
export function addProductToWatchlist(
  source: string,
  productCode: string,
): boolean {
  const result = database
    .prepare(
      `
        INSERT INTO watches (
          source,
          product_code
        )
        VALUES (?, ?)
        ON CONFLICT (source, product_code) DO NOTHING
      `,
    )
    .run(source, productCode);

  return result.changes === 1;
}

/**
 * Removes a product and its availability state from the watchlist.
 * Returns false when the product was not being monitored.
 */
export function removeProductFromWatchlist(
  source: string,
  productCode: string,
): boolean {
  const result = database
    .prepare(
      `
        DELETE FROM watches
        WHERE source = ? AND product_code = ?
      `,
    )
    .run(source, productCode);

  return result.changes === 1;
}

/**
 * Returns the product codes currently monitored for a source.
 */
export function getWatchedProductCodes(source: string): string[] {
  const rows = database
    .prepare(
      `
        SELECT product_code
        FROM watches
        WHERE source = ?
        ORDER BY id
      `,
    )
    .all(source) as WatchedProductRow[];

  return rows.map((row) => row.product_code);
}

/**
 * Returns monitored products with their last saved availability state.
 */
export function getWatchlist(source: string): WatchlistItem[] {
  const rows = database
    .prepare(
      `
        SELECT
          watches.product_code,
          availability_status.is_available,
          availability_status.last_checked_at
        FROM watches
        LEFT JOIN availability_status
          ON availability_status.watch_id = watches.id
        WHERE watches.source = ?
        ORDER BY watches.id
      `,
    )
    .all(source) as WatchlistItemRow[];

  return rows.map((row) => ({
    productCode: row.product_code,
    isAvailable: row.is_available === null ? undefined : row.is_available === 1,
    lastCheckedAt: row.last_checked_at ?? undefined,
  }));
}

/**
 * Returns the previous availability or undefined when no state is stored.
 */
export function getPreviousAvailability(
  source: string,
  productCode: string,
): boolean | undefined {
  const row = database
    .prepare(
      `
        SELECT availability_status.is_available
        FROM availability_status
        INNER JOIN watches
          ON watches.id = availability_status.watch_id
        WHERE watches.source = ?
          AND watches.product_code = ?
      `,
    )
    .get(source, productCode) as AvailabilityRow | undefined;

  if (row === undefined) {
    return undefined;
  }

  return row.is_available === 1;
}

/**
 * Inserts a new availability state or updates the existing one.
 */
export function saveAvailability(
  source: string,
  productCode: string,
  isAvailable: boolean,
): void {
  const watch = database
    .prepare(
      `
        SELECT id
        FROM watches
        WHERE source = ? AND product_code = ?
      `,
    )
    .get(source, productCode) as WatchRow | undefined;

  if (watch === undefined) {
    throw new Error("Cannot save availability for an unmonitored product.");
  }

  database
    .prepare(
      `
        INSERT INTO availability_status (
          watch_id,
          is_available
        )
        VALUES (?, ?)
        ON CONFLICT (watch_id)
        DO UPDATE SET
          is_available = excluded.is_available,
          last_checked_at = CURRENT_TIMESTAMP
      `,
    )
    .run(watch.id, isAvailable ? 1 : 0);
}
