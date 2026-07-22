/**
 * Starts and coordinates Availability Watcher.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 * Updated: 2026-07-23
 */

import { setTimeout as wait } from "node:timers/promises";
import {
  addProductToWatchlist,
  getPreviousAvailability,
  getWatchedProductCodes,
  removeProductFromWatchlist,
  saveAvailability,
} from "./database.js";
import { validateAndConvertToIsbn13 } from "./isbn.js";
import { isUsedBookAvailableOnLibraccio } from "./libraccio.js";
import { getTelegramUpdates, sendTelegramMessage } from "./telegram.js";

type PendingCommand = "/watch" | "/unwatch";

const source = "libraccio";
const allowedChatId = process.env.TELEGRAM_CHAT_ID;
const checkIntervalMinutes = 30;
const checkIntervalMilliseconds = checkIntervalMinutes * 60 * 1000;

const helpMessage =
  "Availability Watcher is ready.\n\n" +
  "Available commands:\n" +
  "/watch - Add a book\n" +
  "/unwatch - Remove a book\n" +
  "/list - Show monitored books\n" +
  "/cancel - Cancel the current operation\n" +
  "/help - Show the available commands";

// Remembers which command is waiting for an ISBN.
// This temporary value resets when the application restarts.
let pendingCommand: PendingCommand | undefined;

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
  const isAvailable = await isUsedBookAvailableOnLibraccio(isbn13);
  const previousAvailability = getPreviousAvailability(source, isbn13);

  // Notifies only when the book was not already available.
  if (isAvailable && previousAvailability !== true) {
    const bookUrl = `https://www.libraccio.it/libro/${isbn13}/book.html`;

    await sendTelegramMessage(
      `Used copy available on Libraccio!\n` + `ISBN-13: ${isbn13}\n` + bookUrl,
    );
  }

  // Stores the state only after the check and notification succeed.
  saveAvailability(source, isbn13, isAvailable);

  return isAvailable;
}

/**
 * Adds a validated ISBN and performs its first availability check.
 */
async function addBookToWatchlist(isbn13: string): Promise<void> {
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
    const reason = error instanceof Error ? `\n${error.message}` : "";

    await sendTelegramMessage(
      `The ISBN was added, but the first check failed.${reason}`,
    );
  }
}

/**
 * Removes a validated ISBN from the watchlist.
 */
async function removeBookFromWatchlist(isbn13: string): Promise<void> {
  const wasRemoved = removeProductFromWatchlist(source, isbn13);

  if (wasRemoved) {
    await sendTelegramMessage(`ISBN removed: ${isbn13}`);
  } else {
    await sendTelegramMessage(`ISBN not found in the watchlist: ${isbn13}`);
  }
}

/**
 * Validates an ISBN and executes the requested command.
 * Returns false when the ISBN is invalid.
 */
async function processIsbnCommand(
  command: PendingCommand,
  isbnInput: string,
): Promise<boolean> {
  const isbn13 = validateAndConvertToIsbn13(isbnInput);

  if (isbn13 === undefined) {
    await sendTelegramMessage("The provided ISBN is not valid.");

    return false;
  }

  if (command === "/watch") {
    await addBookToWatchlist(isbn13);
  } else {
    await removeBookFromWatchlist(isbn13);
  }

  return true;
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
    watchedProducts.map((isbn13) => `- ${isbn13}`).join("\n");

  await sendTelegramMessage(message);
}

/**
 * Interprets one authorized Telegram text message.
 */
async function handleTelegramMessage(text: string): Promise<void> {
  const messageText = text.trim();

  if (pendingCommand !== undefined) {
    if (messageText === "/cancel") {
      pendingCommand = undefined;
      await sendTelegramMessage("Operation canceled.");

      return;
    }

    if (!messageText.startsWith("/")) {
      const wasIsbnValid = await processIsbnCommand(
        pendingCommand,
        messageText,
      );

      if (wasIsbnValid) {
        pendingCommand = undefined;
      } else {
        await sendTelegramMessage("Send another ISBN or use /cancel.");
      }

      return;
    }

    // A new command interrupts the current operation.
    pendingCommand = undefined;
  }

  const commandParts = messageText.split(/\s+/);
  const command = commandParts[0];

  // Joins the remaining parts so ISBNs containing spaces are accepted.
  const isbnInput = commandParts.slice(1).join("");

  if (command === "/start" || command === "/help") {
    await sendTelegramMessage(helpMessage);
  } else if (command === "/watch" || command === "/unwatch") {
    if (isbnInput === "") {
      pendingCommand = command;

      const action = command === "/watch" ? "monitor" : "remove";

      await sendTelegramMessage(
        `Send me the ISBN of the book you want to ${action}.\n\n/cancel`,
      );
    } else {
      await processIsbnCommand(command, isbnInput);
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

/**
 * Keeps requesting and processing Telegram messages.
 */
async function runTelegramBot(): Promise<void> {
  let nextUpdateId = 0;

  while (true) {
    const updates = await getTelegramUpdates(nextUpdateId);

    for (const update of updates) {
      const message = update.message;

      if (
        message?.text !== undefined &&
        String(message.chat.id) === allowedChatId
      ) {
        console.log(`Received Telegram message: ${message.text}`);

        try {
          await handleTelegramMessage(message.text);
        } catch (error) {
          const reason = error instanceof Error ? `: ${error.message}` : "";

          console.error(`Unable to handle Telegram message${reason}`);
        }
      }

      // Prevents Telegram from returning this update again.
      nextUpdateId = update.update_id + 1;
    }
  }
}

/**
 * Periodically checks every ISBN stored in the watchlist.
 */
async function runPeriodicChecks(): Promise<void> {
  while (true) {
    const watchedProducts = getWatchedProductCodes(source);

    console.log(`Checking ${watchedProducts.length} monitored book(s).`);

    // Checks one book at a time.
    for (const isbn13 of watchedProducts) {
      try {
        const isAvailable = await checkWatchedBook(isbn13);
        const result = isAvailable ? "available" : "not available";

        console.log(`${isbn13}: ${result}`);
      } catch (error) {
        const reason = error instanceof Error ? `: ${error.message}` : "";

        console.error(`Unable to check ${isbn13}${reason}`);
      }
    }

    console.log(`Next automatic check in ${checkIntervalMinutes} minutes.`);

    // Starts the pause only after all current checks have finished.
    await wait(checkIntervalMilliseconds);
  }
}

console.log("Availability Watcher is running.");

// Keeps the Telegram bot and automatic checks running together.
await Promise.all([runTelegramBot(), runPeriodicChecks()]);
