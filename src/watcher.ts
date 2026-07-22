/**
 * Coordinates product availability checks and notifications.
 *
 * Author: Dario Santoni
 * Created: 2026-07-22
 */

import { getPreviousAvailability, saveAvailability } from "./database.js";
import { isUsedBookAvailableOnLibraccio } from "./libraccio.js";
import { sendTelegramMessage } from "./telegram.js";

// Identifies the store used by the current version.
const source = "libraccio";

/**
 * Checks a monitored book and returns its current availability.
 */
export async function checkWatchedBook(isbn13: string): Promise<boolean> {
  // Requests the current availability from Libraccio.
  const isAvailable = await isUsedBookAvailableOnLibraccio(isbn13);

  // Reads the last successful result stored in SQLite.
  const previousAvailability = getPreviousAvailability(source, isbn13);

  // Notifies only when the book was not already available.
  const shouldNotify = isAvailable && previousAvailability !== true;

  if (shouldNotify) {
    const bookUrl = `https://www.libraccio.it/libro/${isbn13}/book.html`;

    const message =
      `Used copy available on Libraccio!\n` + `ISBN-13: ${isbn13}\n` + bookUrl;

    await sendTelegramMessage(message);
  }

  // Stores the new state only after the check and notification succeed.
  saveAvailability(source, isbn13, isAvailable);

  return isAvailable;
}
