/**
 * Starts and coordinates Availability Watcher.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 * Updated: 2026-07-23
 */

import {
  addProductToWatchlist,
  getPreviousAvailability,
  getWatchedProductCodes,
  saveAvailability,
} from "./database.js";
import { validateAndConvertToIsbn13 } from "./isbn.js";
import { isUsedBookAvailableOnLibraccio } from "./libraccio.js";
import { getTelegramUpdates, sendTelegramMessage } from "./telegram.js";

const source = "libraccio";
const allowedChatId = process.env.TELEGRAM_CHAT_ID;

const helpMessage =
  "Availability Watcher is ready.\n\n" +
  "Available commands:\n" +
  "/watch - Add a book\n" +
  "/list - Show monitored books\n" +
  "/cancel - Cancel the current operation\n" +
  "/help - Show the available commands";

// Remembers whether the bot is waiting for an ISBN.
// This temporary value resets when the application restarts.
let isWaitingForIsbn = false;

// The bot token and authorized chat are required to start the application.
if (
  process.env.TELEGRAM_BOT_TOKEN === undefined ||
  allowedChatId === undefined
) {
  throw new Error("Telegram configuration is missing.");
}

/**
 * Checks a monitored book and returns its current availability.
 */
async function checkWatchedBook(isbn13: string): Promise<boolean> {
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

  // Stores the state only after the check and notification succeed.
  saveAvailability(source, isbn13, isAvailable);

  return isAvailable;
}

/**
 * Validates an ISBN, adds it to the watchlist and performs its first check.
 */
async function addBookToWatchlist(isbnInput: string): Promise<void> {
  const isbn13 = validateAndConvertToIsbn13(isbnInput);

  if (isbn13 === undefined) {
    await sendTelegramMessage("The provided ISBN is not valid.");

    return;
  }

  const wasAdded = addProductToWatchlist(source, isbn13);

  if (!wasAdded) {
    await sendTelegramMessage(`ISBN already monitored: ${isbn13}`);

    return;
  }

  await sendTelegramMessage(`ISBN added: ${isbn13}\nChecking Libraccio...`);

  try {
    const isAvailable = await checkWatchedBook(isbn13);

    if (!isAvailable) {
      await sendTelegramMessage(
        "No used copy currently available on Libraccio.",
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      await sendTelegramMessage(
        `The ISBN was added, but the first check failed:\n${error.message}`,
      );
    } else {
      await sendTelegramMessage(
        "The ISBN was added, but the first check failed.",
      );
    }
  }
}

/**
 * Sends the ISBNs currently stored in the watchlist.
 */
async function showWatchlist(): Promise<void> {
  const watchedProducts = getWatchedProductCodes(source);

  if (watchedProducts.length === 0) {
    await sendTelegramMessage("The watchlist is empty.");

    return;
  }

  const message =
    "Monitored ISBNs:\n" +
    watchedProducts.map((productCode) => `- ${productCode}`).join("\n");

  await sendTelegramMessage(message);
}

/**
 * Interprets one authorized Telegram text message.
 */
async function handleTelegramMessage(text: string): Promise<void> {
  const messageText = text.trim();

  if (isWaitingForIsbn) {
    if (messageText === "/cancel") {
      isWaitingForIsbn = false;
      await sendTelegramMessage("Operation canceled.");

      return;
    }

    // A different command interrupts the ISBN request.
    if (messageText.startsWith("/")) {
      isWaitingForIsbn = false;
    } else {
      isWaitingForIsbn = false;
      await addBookToWatchlist(messageText);

      return;
    }
  }

  const commandParts = messageText.split(/\s+/);
  const command = commandParts[0];

  // Joins the remaining parts so ISBNs containing spaces are accepted.
  const isbnInput = commandParts.slice(1).join("");

  if (command === "/start" || command === "/help") {
    await sendTelegramMessage(helpMessage);
  } else if (command === "/watch") {
    if (isbnInput === "") {
      isWaitingForIsbn = true;

      await sendTelegramMessage(
        "Send me the ISBN of the book you want to monitor.\n\n" + "/cancel",
      );
    } else {
      await addBookToWatchlist(isbnInput);
    }
  } else if (command === "/list") {
    await showWatchlist();
  } else if (command === "/cancel") {
    await sendTelegramMessage("There is no operation to cancel.");
  } else {
    await sendTelegramMessage(
      "Unknown command. Send /help to see the available commands.",
    );
  }
}

// Identifies the first Telegram update that has not been handled yet.
let nextUpdateId = 0;

console.log("Availability Watcher Telegram bot is running.");

// Keeps the application running and waiting for Telegram messages.
while (true) {
  const updates = await getTelegramUpdates(nextUpdateId);

  // Processes every update returned by Telegram.
  for (const update of updates) {
    const message = update.message;

    // Handles only text messages coming from the authorized chat.
    if (
      message !== undefined &&
      message.text !== undefined &&
      String(message.chat.id) === allowedChatId
    ) {
      console.log(`Received Telegram message: ${message.text}`);

      try {
        await handleTelegramMessage(message.text);
      } catch (error) {
        if (error instanceof Error) {
          console.error(`Unable to handle Telegram message: ${error.message}`);
        } else {
          console.error("Unable to handle Telegram message.");
        }
      }
    }

    // The next request will not return this update again.
    nextUpdateId = update.update_id + 1;
  }
}
