/**
 * Stores and retrieves users, products, watches, and availability states.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 * Updated: 2026-07-26
 */

import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { BookMetadata } from "./book-metadata.js";

const dataDirectory = "data";
const backupDirectory = join(dataDirectory, "backups");
const databasePath = join(dataDirectory, "availability-watcher.db");

// Creates the data directory if it does not already exist.
mkdirSync(dataDirectory, { recursive: true });

// Opens the database file or creates it on the first execution.
const database = new Database(databasePath);

// Enables relationships between SQLite tables for this connection.
database.pragma("foreign_keys = ON");

// Creates the required tables only when they do not already exist.
database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    telegram_chat_id INTEGER NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT;

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    product_code TEXT NOT NULL UNIQUE,
    title TEXT,
    authors TEXT,
    edition_year INTEGER,
    publisher TEXT,
    metadata_source TEXT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS availability_status (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    is_available INTEGER,
    new_price_cents INTEGER
      CHECK (new_price_cents IS NULL OR new_price_cents >= 0),
    used_price_cents INTEGER
      CHECK (used_price_cents IS NULL OR used_price_cents >= 0),
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

  CREATE TABLE IF NOT EXISTS watches (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    availability_status_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (user_id, availability_status_id),

    FOREIGN KEY (user_id)
      REFERENCES users (id)
      ON DELETE CASCADE,

    FOREIGN KEY (availability_status_id)
      REFERENCES availability_status (id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX IF NOT EXISTS watches_availability_status_id_index
  ON watches (availability_status_id);
`);

// Adds price columns to databases created before price tracking existed.
const availabilityStatusColumns = database
  .prepare("PRAGMA table_info(availability_status)")
  .all() as Array<{ name: string }>;

if (
  !availabilityStatusColumns.some((column) => column.name === "new_price_cents")
) {
  database.exec(`
    ALTER TABLE availability_status
    ADD COLUMN new_price_cents INTEGER
      CHECK (new_price_cents IS NULL OR new_price_cents >= 0)
  `);
}

if (
  !availabilityStatusColumns.some(
    (column) => column.name === "used_price_cents",
  )
) {
  database.exec(`
    ALTER TABLE availability_status
    ADD COLUMN used_price_cents INTEGER
      CHECK (used_price_cents IS NULL OR used_price_cents >= 0)
  `);
}

interface IdRow {
  id: number;
}

interface CountRow {
  total: number;
}

interface BotStatisticsRow {
  registered_users: number;
  active_users: number;
  total_watches: number;
  unique_books: number;
  available_books: number;
  unknown_books: number;
}

interface ProductDetailsRow {
  title: string | null;
  authors: string | null;
}

interface WatchedProductRow {
  product_code: string;
}

interface AvailabilityRow {
  is_available: number | null;
}

interface TelegramChatIdRow {
  telegram_chat_id: number;
}

interface WatchlistItemRow {
  product_code: string;
  title: string | null;
  authors: string | null;
  edition_year: number | null;
  publisher: string | null;
  is_available: number | null;
  new_price_cents: number | null;
  used_price_cents: number | null;
  last_checked_at: string | null;
}

export type AddWatchResult =
  | "added"
  | "already-watched"
  | "watch-limit-reached"
  | "user-limit-reached"
  | "book-limit-reached";

export interface AddWatchLimits {
  maximumActiveUsers: number;
  maximumWatchesPerUser: number;
  maximumUniqueBooks: number;
}

export interface BotStatistics {
  registeredUsers: number;
  activeUsers: number;
  totalWatches: number;
  uniqueBooks: number;
  availableBooks: number;
  unknownBooks: number;
}

export interface ProductDetails {
  title: string | undefined;
  authors: string | undefined;
}

export interface WatchlistItem {
  productCode: string;
  title: string | undefined;
  authors: string | undefined;
  editionYear: number | undefined;
  publisher: string | undefined;
  isAvailable: boolean | undefined;
  newPriceInCents: number | undefined;
  usedPriceInCents: number | undefined;
  lastCheckedAt: string | undefined;
}

/**
 * Registers a Telegram user if the Chat ID is not already stored.
 */
export function registerTelegramUser(telegramChatId: number): void {
  database
    .prepare(
      `
        INSERT INTO users (
          telegram_chat_id
        )
        VALUES (?)
        ON CONFLICT (telegram_chat_id) DO NOTHING
      `,
    )
    .run(telegramChatId);
}

/**
 * Deletes one Telegram user and all watches linked to them.
 */
export function deleteTelegramUser(telegramChatId: number): boolean {
  // Related watches are removed automatically by the foreign-key cascade.
  const result = database
    .prepare(
      `
        DELETE FROM users
        WHERE telegram_chat_id = ?
      `,
    )
    .run(telegramChatId);

  return result.changes === 1;
}

/**
 * Returns a summary of the current bot usage for one availability source.
 */
export function getBotStatistics(source: string): BotStatistics {
  const row = database
    .prepare(
      `
        SELECT
          (SELECT COUNT(*) FROM users) AS registered_users,
          COUNT(DISTINCT watches.user_id) AS active_users,
          COUNT(watches.id) AS total_watches,
          COUNT(DISTINCT availability_status.id) AS unique_books,
          COUNT(
            DISTINCT CASE
              WHEN availability_status.is_available = 1
              THEN availability_status.id
            END
          ) AS available_books,
          COUNT(
            DISTINCT CASE
              WHEN availability_status.is_available IS NULL
              THEN availability_status.id
            END
          ) AS unknown_books
        FROM watches
        INNER JOIN availability_status
          ON availability_status.id = watches.availability_status_id
        WHERE availability_status.source = ?
      `,
    )
    .get(source) as BotStatisticsRow;

  return {
    registeredUsers: row.registered_users,
    activeUsers: row.active_users,
    totalWatches: row.total_watches,
    uniqueBooks: row.unique_books,
    availableBooks: row.available_books,
    unknownBooks: row.unknown_books,
  };
}

/**
 * Adds a product to one user's watchlist while enforcing the configured limits.
 */
export function addProductToWatchlist(
  telegramChatId: number,
  source: string,
  productCode: string,
  limits: AddWatchLimits,
): AddWatchResult {
  const user = database
    .prepare(
      `
        SELECT id
        FROM users
        WHERE telegram_chat_id = ?
      `,
    )
    .get(telegramChatId) as IdRow | undefined;

  if (user === undefined) {
    throw new Error("Cannot add a watch for an unknown user.");
  }

  const existingWatch = database
    .prepare(
      `
        SELECT watches.id
        FROM watches
        INNER JOIN availability_status
          ON availability_status.id = watches.availability_status_id
        INNER JOIN products
          ON products.id = availability_status.product_id
        WHERE watches.user_id = ?
          AND availability_status.source = ?
          AND products.product_code = ?
      `,
    )
    .get(user.id, source, productCode) as IdRow | undefined;

  if (existingWatch !== undefined) {
    return "already-watched";
  }

  const userWatchCount = database
    .prepare(
      `
        SELECT COUNT(*) AS total
        FROM watches
        WHERE user_id = ?
      `,
    )
    .get(user.id) as CountRow;

  if (userWatchCount.total >= limits.maximumWatchesPerUser) {
    return "watch-limit-reached";
  }

  if (userWatchCount.total === 0) {
    const activeUserCount = database
      .prepare(
        `
          SELECT COUNT(DISTINCT user_id) AS total
          FROM watches
        `,
      )
      .get() as CountRow;

    if (activeUserCount.total >= limits.maximumActiveUsers) {
      return "user-limit-reached";
    }
  }

  const existingGlobalWatch = database
    .prepare(
      `
        SELECT watches.id
        FROM watches
        INNER JOIN availability_status
          ON availability_status.id = watches.availability_status_id
        INNER JOIN products
          ON products.id = availability_status.product_id
        WHERE availability_status.source = ?
          AND products.product_code = ?
        LIMIT 1
      `,
    )
    .get(source, productCode) as IdRow | undefined;

  if (existingGlobalWatch === undefined) {
    const uniqueBookCount = database
      .prepare(
        `
          SELECT COUNT(DISTINCT availability_status.id) AS total
          FROM watches
          INNER JOIN availability_status
            ON availability_status.id = watches.availability_status_id
          WHERE availability_status.source = ?
        `,
      )
      .get(source) as CountRow;

    if (uniqueBookCount.total >= limits.maximumUniqueBooks) {
      return "book-limit-reached";
    }
  }

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
    .get(productCode) as IdRow | undefined;

  if (product === undefined) {
    throw new Error("Unable to find the product after adding it.");
  }

  database
    .prepare(
      `
        INSERT INTO availability_status (
          source,
          product_id
        )
        VALUES (?, ?)
        ON CONFLICT (source, product_id) DO NOTHING
      `,
    )
    .run(source, product.id);

  const availabilityStatus = database
    .prepare(
      `
        SELECT id
        FROM availability_status
        WHERE source = ?
          AND product_id = ?
      `,
    )
    .get(source, product.id) as IdRow | undefined;

  if (availabilityStatus === undefined) {
    throw new Error("Unable to create the availability status.");
  }

  const result = database
    .prepare(
      `
        INSERT INTO watches (
          user_id,
          availability_status_id
        )
        VALUES (?, ?)
      `,
    )
    .run(user.id, availabilityStatus.id);

  if (result.changes !== 1) {
    throw new Error("Unable to add the book to the watchlist.");
  }

  return "added";
}

/**
 * Saves product information without erasing previously known optional values.
 */
export function saveProductMetadata(
  productCode: string,
  metadata: BookMetadata,
): void {
  const result = database
    .prepare(
      `
        UPDATE products
        SET
          title = ?,
          authors = COALESCE(?, authors),
          edition_year = COALESCE(?, edition_year),
          publisher = COALESCE(?, publisher),
          metadata_source = ?
        WHERE product_code = ?
      `,
    )
    .run(
      metadata.title,
      metadata.authors ?? null,
      metadata.editionYear ?? null,
      metadata.publisher ?? null,
      metadata.source,
      productCode,
    );

  if (result.changes !== 1) {
    throw new Error("Cannot save metadata for an unknown product.");
  }
}

/**
 * Returns the stored title and authors of one product.
 */
export function getProductDetails(
  productCode: string,
): ProductDetails | undefined {
  const row = database
    .prepare(
      `
        SELECT
          title,
          authors
        FROM products
        WHERE product_code = ?
      `,
    )
    .get(productCode) as ProductDetailsRow | undefined;

  if (row === undefined) {
    return undefined;
  }

  return {
    title: row.title ?? undefined,
    authors: row.authors ?? undefined,
  };
}

/**
 * Removes a product from one user's watchlist.
 */
export function removeProductFromWatchlist(
  telegramChatId: number,
  source: string,
  productCode: string,
): boolean {
  const result = database
    .prepare(
      `
        DELETE FROM watches
        WHERE user_id = (
          SELECT id
          FROM users
          WHERE telegram_chat_id = ?
        )
          AND availability_status_id = (
            SELECT availability_status.id
            FROM availability_status
            INNER JOIN products
              ON products.id = availability_status.product_id
            WHERE availability_status.source = ?
              AND products.product_code = ?
          )
      `,
    )
    .run(telegramChatId, source, productCode);

  return result.changes === 1;
}

/**
 * Returns products that have watchers and are due for a new check.
 */
export function getProductCodesDueForCheck(
  source: string,
  checkIntervalMinutes: number,
): string[] {
  const minimumAge = `-${checkIntervalMinutes} minutes`;

  const rows = database
    .prepare(
      `
        SELECT products.product_code
        FROM availability_status
        INNER JOIN products
          ON products.id = availability_status.product_id
        INNER JOIN watches
          ON watches.availability_status_id = availability_status.id
        WHERE availability_status.source = ?
          AND (
            availability_status.last_checked_at IS NULL
            OR availability_status.last_checked_at <= datetime('now', ?)
          )
        GROUP BY
          availability_status.id,
          products.product_code
        ORDER BY availability_status.id
      `,
    )
    .all(source, minimumAge) as WatchedProductRow[];

  return rows.map((row) => row.product_code);
}

/**
 * Returns one user's monitored products and their availability states.
 */
export function getWatchlist(
  telegramChatId: number,
  source: string,
): WatchlistItem[] {
  const rows = database
    .prepare(
      `
        SELECT
          products.product_code,
          products.title,
          products.authors,
          products.edition_year,
          products.publisher,
          availability_status.is_available,
          availability_status.new_price_cents,
          availability_status.used_price_cents,
          availability_status.last_checked_at
        FROM watches
        INNER JOIN users
          ON users.id = watches.user_id
        INNER JOIN availability_status
          ON availability_status.id = watches.availability_status_id
        INNER JOIN products
          ON products.id = availability_status.product_id
        WHERE users.telegram_chat_id = ?
          AND availability_status.source = ?
        ORDER BY watches.id
      `,
    )
    .all(telegramChatId, source) as WatchlistItemRow[];

  return rows.map((row) => ({
    productCode: row.product_code,
    title: row.title ?? undefined,
    authors: row.authors ?? undefined,
    editionYear: row.edition_year ?? undefined,
    publisher: row.publisher ?? undefined,
    isAvailable: row.is_available === null ? undefined : row.is_available === 1,
    newPriceInCents: row.new_price_cents ?? undefined,
    usedPriceInCents: row.used_price_cents ?? undefined,
    lastCheckedAt: row.last_checked_at ?? undefined,
  }));
}

/**
 * Returns the previous global availability of one product.
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
        INNER JOIN products
          ON products.id = availability_status.product_id
        WHERE availability_status.source = ?
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
 * Returns the Chat IDs of all users monitoring one product.
 */
export function getTelegramChatIdsWatchingProduct(
  source: string,
  productCode: string,
): number[] {
  const rows = database
    .prepare(
      `
        SELECT users.telegram_chat_id
        FROM watches
        INNER JOIN users
          ON users.id = watches.user_id
        INNER JOIN availability_status
          ON availability_status.id = watches.availability_status_id
        INNER JOIN products
          ON products.id = availability_status.product_id
        WHERE availability_status.source = ?
          AND products.product_code = ?
        ORDER BY watches.id
      `,
    )
    .all(source, productCode) as TelegramChatIdRow[];

  return rows.map((row) => row.telegram_chat_id);
}

/**
 * Updates the global availability state of one product.
 */
export function saveAvailability(
  source: string,
  productCode: string,
  isAvailable: boolean,
  newPriceInCents: number | undefined,
  usedPriceInCents: number | undefined,
): void {
  const result = database
    .prepare(
      `
        UPDATE availability_status
        SET
          is_available = ?,
          new_price_cents = ?,
          used_price_cents = ?,
          last_checked_at = CURRENT_TIMESTAMP
        WHERE source = ?
          AND product_id = (
            SELECT id
            FROM products
            WHERE product_code = ?
          )
      `,
    )
    .run(
      isAvailable ? 1 : 0,
      newPriceInCents ?? null,
      usedPriceInCents ?? null,
      source,
      productCode,
    );

  if (result.changes !== 1) {
    throw new Error("Cannot save availability for an unknown product.");
  }
}

/**
 * Creates a consistent database backup and keeps only the newest copies.
 */
export async function createDatabaseBackup(
  maximumBackups: number,
): Promise<string> {
  mkdirSync(backupDirectory, { recursive: true });

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const backupFileName = `availability-watcher-${timestamp}.db`;
  const backupPath = join(backupDirectory, backupFileName);

  await database.backup(backupPath);

  const backupFiles = readdirSync(backupDirectory)
    .filter(
      (fileName) =>
        fileName.startsWith("availability-watcher-") &&
        fileName.endsWith(".db"),
    )
    .sort();

  const outdatedBackupCount = Math.max(0, backupFiles.length - maximumBackups);

  for (const fileName of backupFiles.slice(0, outdatedBackupCount)) {
    unlinkSync(join(backupDirectory, fileName));
  }

  return backupPath;
}
