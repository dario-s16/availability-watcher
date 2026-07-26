/**
 * Starts and coordinates Availability Watcher.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 * Updated: 2026-07-26
 */

import { setTimeout } from "node:timers/promises";
import { getBookMetadata } from "./book-metadata.js";
import {
  addProductToWatchlist,
  getPreviousAvailability,
  getProductCodesDueForCheck,
  getProductDetails,
  getWatchlist,
  removeProductFromWatchlist,
  saveAvailability,
  saveProductMetadata,
} from "./database.js";
import { validateAndConvertToIsbn13 } from "./isbn.js";
import {
  getLibraccioBookData,
  type LibraccioAvailability,
} from "./libraccio.js";
import { getTelegramUpdates, sendTelegramMessage } from "./telegram.js";

type PendingCommand = "/watch" | "/unwatch";

const source = "libraccio";
const allowedChatId = process.env.TELEGRAM_CHAT_ID;

const checkIntervalMinutes = 30;
const checkIntervalMilliseconds = checkIntervalMinutes * 60 * 1000;

const requestDelaySeconds = 3;
const requestDelayMilliseconds = requestDelaySeconds * 1000;

const telegramRetryDelaySeconds = 5;
const telegramRetryDelayMilliseconds = telegramRetryDelaySeconds * 1000;

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
 * Saves an availability result and sends a notification when needed.
 */
async function saveAvailabilityAndNotifyIfNeeded(
  isbn13: string,
  availability: LibraccioAvailability,
): Promise<void> {
  // A missing page is not an availability state to save.
  if (availability === "not-found") {
    return;
  }

  const isAvailable = availability === "available";
  const previousAvailability = getPreviousAvailability(source, isbn13);

  // Notifies only when the book was not already available.
  if (isAvailable && previousAvailability !== true) {
    const product = getProductDetails(isbn13);
    const title = product?.title ?? "not available";
    const authors = product?.authors ?? "not available";
    const bookUrl = `https://www.libraccio.it/libro/${isbn13}/book.html`;

    await sendTelegramMessage(
      `✅ Used copy available on Libraccio!\n\n` +
        `Title: ${title}\n` +
        `Authors: ${authors}\n` +
        `ISBN: ${isbn13}\n\n` +
        bookUrl,
    );
  }

  // Stores the state only after the check and notification succeeds.
  saveAvailability(source, isbn13, isAvailable);
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

  let libraccioBook;

  try {
    libraccioBook = await getLibraccioBookData(isbn13);
  } catch (error) {
    const reason = error instanceof Error ? `\n${error.message}` : "";

    await sendTelegramMessage(
      `The ISBN was added, but the first availability check ` +
        `could not be completed.${reason}`,
    );

    return;
  }

  if (libraccioBook.availability === "not-found") {
    // Removes an ISBN that has no corresponding Libraccio page.
    removeProductFromWatchlist(source, isbn13);

    await sendTelegramMessage(
      `ISBN removed: Libraccio has no page for ${isbn13}.`,
    );

    return;
  }

  // APIs are preferred, while Libraccio completes any missing fields.
  const metadata = await getBookMetadata(isbn13, libraccioBook.metadata);

  if (metadata === undefined) {
    console.log(`No metadata found for ${isbn13}.`);
  } else {
    saveProductMetadata(isbn13, metadata);

    console.log(`Metadata saved for ${isbn13} from ${metadata.source}.`);
  }

  await saveAvailabilityAndNotifyIfNeeded(isbn13, libraccioBook.availability);

  if (libraccioBook.availability === "unavailable") {
    await sendTelegramMessage("No used copy currently available on Libraccio.");
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
 * Converts a UTC timestamp stored by SQLite into Italian date and time.
 */
function formatUtcDateForItaly(utcDateText: string): string {
  // Converts "2026-07-25 13:31:24" into a timestamp recognized as UTC.
  const date = new Date(`${utcDateText.replace(" ", "T")}Z`);

  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Rome",
  }).format(date);
}

/**
 * Escapes text received from external metadata before using Telegram HTML.
 */
function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Sends one compact list with book links and latest used availability.
 */
async function showWatchlist(): Promise<void> {
  const watchlist = getWatchlist(source);

  if (watchlist.length === 0) {
    await sendTelegramMessage("The watchlist is empty.");

    return;
  }

  const availableCount = watchlist.filter(
    (item) => item.isAvailable === true,
  ).length;

  const unavailableCount = watchlist.filter(
    (item) => item.isAvailable === false,
  ).length;

  const unknownCount = watchlist.filter(
    (item) => item.isAvailable === undefined,
  ).length;

  const books = watchlist.map((item) => {
    const title = escapeTelegramHtml(item.title ?? "Title not available");

    const authors =
      item.authors === undefined ? undefined : escapeTelegramHtml(item.authors);

    const availabilityIcon =
      item.isAvailable === undefined ? "❔" : item.isAvailable ? "✅" : "❌";

    const bookUrl =
      `https://www.libraccio.it/libro/` + `${item.productCode}/book.html`;

    const lines = [`${availabilityIcon} <a href="${bookUrl}">${title}</a>`];

    if (authors !== undefined) {
      lines.push(`Authors: ${authors}`);
    }

    if (item.editionYear !== undefined) {
      lines.push(`Edition year: ${item.editionYear}`);
    }

    lines.push(`ISBN: ${item.productCode}`);

    if (item.lastCheckedAt === undefined) {
      lines.push("Used availability checked: no successful check yet");
    } else {
      lines.push(
        `Used availability checked: ${formatUtcDateForItaly(item.lastCheckedAt)}`,
      );
    }

    return lines.join("\n");
  });

  const message =
    `📚 Monitored books: ${watchlist.length}\n` +
    `Used copies: ✅ ${availableCount} available · ` +
    `❌ ${unavailableCount} unavailable · ` +
    `❔ ${unknownCount} unknown\n\n` +
    books.join("\n\n");

  await sendTelegramMessage(message, {
    parseMode: "HTML",
    disableLinkPreview: true,
  });
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
    try {
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
    } catch (error) {
      const reason = error instanceof Error ? `: ${error.message}` : "";

      console.error(`Unable to receive Telegram messages${reason}`);
      console.log(`Retrying Telegram in ${telegramRetryDelaySeconds} seconds.`);

      // A temporary network error must not stop the application.
      await setTimeout(telegramRetryDelayMilliseconds);
    }
  }
}

/**
 * Periodically checks books that are due for a new availability check.
 */
async function runPeriodicChecks(): Promise<void> {
  while (true) {
    const productsDueForCheck = getProductCodesDueForCheck(
      source,
      checkIntervalMinutes,
    );

    let checkedBooks = 0;

    if (productsDueForCheck.length === 0) {
      console.log("No monitored books currently need an availability check.");
    } else {
      console.log(`Checking ${productsDueForCheck.length} monitored book(s).`);
    }

    // Checks one book at a time.
    for (const isbn13 of productsDueForCheck) {
      try {
        const libraccioBook = await getLibraccioBookData(isbn13);

        await saveAvailabilityAndNotifyIfNeeded(
          isbn13,
          libraccioBook.availability,
        );

        let result = "available";

        if (libraccioBook.availability === "unavailable") {
          result = "not available";
        } else if (libraccioBook.availability === "not-found") {
          result = "page not found";
        }

        console.log(`${isbn13}: ${result}`);
      } catch (error) {
        const reason = error instanceof Error ? `: ${error.message}` : "";

        console.error(`Unable to check ${isbn13}${reason}`);
      }

      checkedBooks += 1;

      // Pauses only when another Libraccio request still has to be made.
      if (checkedBooks < productsDueForCheck.length) {
        await setTimeout(requestDelayMilliseconds);
      }
    }

    console.log(`Next automatic check in ${checkIntervalMinutes} minutes.`);

    // Starts the interval only after the current checks have finished.
    await setTimeout(checkIntervalMilliseconds);
  }
}

console.log("Availability Watcher is running.");

// Keeps the Telegram bot and automatic checks running together.
await Promise.all([runTelegramBot(), runPeriodicChecks()]);
