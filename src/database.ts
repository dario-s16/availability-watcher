/**
 * Stores and retrieves products, watches, and availability states using SQLite.
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
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    product_code TEXT NOT NULL UNIQUE,
    title TEXT,
    authors TEXT,
    publication_year INTEGER,
    publisher TEXT,
    metadata_source TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_available INTEGER,
    last_checked_at TEXT,

    UNIQUE (source, product_id),

    FOREIGN KEY (product_id)
      REFERENCES products (id)
      ON DELETE CASCADE,

    CHECK (
      (is_available IS NULL AND last_checked_at IS NULL)
      OR
      (
        is_available IN (0, 1)
        AND last_checked_at IS NOT NULL
      )
    )
  ) STRICT;
`);

interface ProductRow {
  id: number;
}

interface WatchedProductRow {
  product_code: string;
}

interface AvailabilityRow {
  is_available: number | null;
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
 * Adds a product to the registry and watchlist.
 * Returns false when the product is already being monitored.
 */
export function addProductToWatchlist(
  source: string,
  productCode: string,
): boolean {
  database
    .prepare(
      `
        INSERT INTO products (
          product_code
        )
        VALUES (?)
        ON CONFLICT (product_code) DO NOTHING
      `,
    )
    .run(productCode);

  const product = database
    .prepare(
      `
        SELECT id
        FROM products
        WHERE product_code = ?
      `,
    )
    .get(productCode) as ProductRow | undefined;

  if (product === undefined) {
    throw new Error("Unable to find the product after adding it.");
  }

  const result = database
    .prepare(
      `
        INSERT INTO watches (
          source,
          product_id
        )
        VALUES (?, ?)
        ON CONFLICT (source, product_id) DO NOTHING
      `,
    )
    .run(source, product.id);

  return result.changes === 1;
}

/**
 * Removes a watch.
 * The product remains in the registry for possible future use.
 */
export function removeProductFromWatchlist(
  source: string,
  productCode: string,
): boolean {
  const result = database
    .prepare(
      `
        DELETE FROM watches
        WHERE source = ?
          AND product_id = (
            SELECT id
            FROM products
            WHERE product_code = ?
          )
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
        SELECT products.product_code
        FROM watches
        INNER JOIN products
          ON products.id = watches.product_id
        WHERE watches.source = ?
        ORDER BY watches.id
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
          products.product_code,
          watches.is_available,
          watches.last_checked_at
        FROM watches
        INNER JOIN products
          ON products.id = watches.product_id
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
        SELECT watches.is_available
        FROM watches
        INNER JOIN products
          ON products.id = watches.product_id
        WHERE watches.source = ?
          AND products.product_code = ?
      `,
    )
    .get(source, productCode) as AvailabilityRow | undefined;

  if (row === undefined || row.is_available === null) {
    return undefined;
  }

  return row.is_available === 1;
}

/**
 * Updates the availability state of a monitored product.
 */
export function saveAvailability(
  source: string,
  productCode: string,
  isAvailable: boolean,
): void {
  const result = database
    .prepare(
      `
        UPDATE watches
        SET
          is_available = ?,
          last_checked_at = CURRENT_TIMESTAMP
        WHERE source = ?
          AND product_id = (
            SELECT id
            FROM products
            WHERE product_code = ?
          )
      `,
    )
    .run(isAvailable ? 1 : 0, source, productCode);

  if (result.changes !== 1) {
    throw new Error("Cannot save availability for an unmonitored product.");
  }
}
