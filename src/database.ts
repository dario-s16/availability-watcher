/**
 * Stores and retrieves availability states using SQLite.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 */

import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";

// Creates the data directory if it does not already exist.
mkdirSync("data", { recursive: true });

// Opens the database file or creates it on the first execution.
const database = new Database("data/availability-watcher.db");

// Creates the table only when it does not already exist.
database.exec(`
  CREATE TABLE IF NOT EXISTS availability_status (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    product_code TEXT NOT NULL,
    is_available INTEGER NOT NULL CHECK (is_available IN (0, 1)),
    last_checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (source, product_code)
  ) STRICT;
`);

interface AvailabilityRow {
  is_available: number;
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
        SELECT is_available
        FROM availability_status
        WHERE source = ? AND product_code = ?
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
  database
    .prepare(
      `
        INSERT INTO availability_status (
          source,
          product_code,
          is_available
        )
        VALUES (?, ?, ?)
        ON CONFLICT (source, product_code)
        DO UPDATE SET
          is_available = excluded.is_available,
          last_checked_at = CURRENT_TIMESTAMP
      `,
    )
    .run(source, productCode, isAvailable ? 1 : 0);
}
