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
  getTelegramChatIdsWatchingProduct,
  getWatchlist,
  registerTelegramUser,
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

const maximumWatchesPerUser = 30;

const checkIntervalMinutes = 30;
const checkIntervalMilliseconds = checkIntervalMinutes * 60 * 1000;

const requestDelaySeconds = 3;
const requestDelayMilliseconds = requestDelaySeconds * 1000;

const telegramRetryDelaySeconds = 5;
const telegramRetryDelayMilliseconds = telegramRetryDelaySeconds * 1000;

const addBookButton = "➕ Add book";
const listBooksButton = "📚 Monitored books";
const removeBookButton = "🗑 Remove book";
const helpButton = "❓ Help";
const cancelButton = "✖ Cancel";

// This keyboard provides the main actions on mobile.
const mainKeyboard = [
  [addBookButton, helpButton],
  [listBooksButton, removeBookButton],
];

// Converts friendly button labels into the existing slash commands.
const buttonCommands: Record<string, string> = {
  [addBookButton]: "/watch",
  [listBooksButton]: "/list",
  [removeBookButton]: "/unwatch",
  [helpButton]: "/help",
  [cancelButton]: "/cancel",
};

const helpMessage =
  "Availability Watcher is ready.\n\n" +
  "Available commands:\n" +
  "/watch - Add a book\n" +
  "/unwatch - Remove a book\n" +
  "/list - Show monitored books\n" +
  "/cancel - Cancel the current operation\n" +
  "/help - Show the available commands";

// Stores one pending command for each Telegram chat.
// These temporary values reset when the application restarts.
const pendingCommands = new Map<number, PendingCommand>();

// The bot token is required to start the application.
if (process.env.TELEGRAM_BOT_TOKEN === undefined) {
  throw new Error("Telegram bot token is missing.");
}

/**
 * Sends a message and shows the main Telegram keyboard.
 */
async function sendMainMenuMessage(
  telegramChatId: number,
  message: string,
): Promise<void> {
  await sendTelegramMessage(telegramChatId, message, {
    keyboard: mainKeyboard,
    persistentKeyboard: true,
  });
}

/**
 * Shortens long titles so removal buttons remain readable on mobile.
 */
function shortenBookTitle(title: string): string {
  const maximumLength = 40;

  if (title.length <= maximumLength) {
    return title;
  }

  return `${title.slice(0, maximumLength - 1)}…`;
}

/**
 * Extracts the ISBN contained at the end of a removal button.
 */
function getIsbnFromRemovalButton(buttonText: string): string {
  const match = buttonText.match(/\[(\d{13})\]$/);

  return match?.[1] ?? buttonText;
}

/**
 * Shows one removal button for every book monitored by one user.
 */
async function showRemoveBookKeyboard(
  telegramChatId: number,
  message = "Choose the book you want to remove.",
): Promise<void> {
  const watchlist = getWatchlist(telegramChatId, source);

  if (watchlist.length === 0) {
    pendingCommands.delete(telegramChatId);

    await sendMainMenuMessage(
      telegramChatId,
      "📚 You are not monitoring any books yet.\n\n" +
        "Use ➕ Add book or send /watch to add one.",
    );

    return;
  }

  // Cancel remains the first and easiest action to reach.
  const removeKeyboard = [[cancelButton]];

  for (const item of watchlist) {
    const title = shortenBookTitle(item.title ?? "Title not available");

    removeKeyboard.push([`${title} [${item.productCode}]`]);
  }

  pendingCommands.set(telegramChatId, "/unwatch");

  await sendTelegramMessage(telegramChatId, message, {
    keyboard: removeKeyboard,
    oneTimeKeyboard: true,
  });
}

/**
 * Saves a global availability result and notifies interested users.
 */
async function saveAvailabilityAndNotifyIfNeeded(
  isbn13: string,
  availability: LibraccioAvailability,
  requestingChatId?: number,
): Promise<void> {
  // A missing page is not an availability state to save.
  if (availability === "not-found") {
    return;
  }

  const isAvailable = availability === "available";
  const previousAvailability = getPreviousAvailability(source, isbn13);

  if (isAvailable) {
    let chatIdsToNotify: number[] = [];

    // A new transition to available interests every user watching the book.
    if (previousAvailability !== true) {
      chatIdsToNotify = getTelegramChatIdsWatchingProduct(source, isbn13);
    } else if (requestingChatId !== undefined) {
      // A new watcher must be informed even when the book was already available.
      chatIdsToNotify = [requestingChatId];
    }

    if (chatIdsToNotify.length > 0) {
      const product = getProductDetails(isbn13);
      const title = product?.title ?? "not available";
      const authors = product?.authors ?? "not available";
      const bookUrl = `https://www.libraccio.it/libro/${isbn13}/book.html`;

      const notification =
        `✅ Used copy available on Libraccio!\n\n` +
        `Title: ${title}\n` +
        `Authors: ${authors}\n` +
        `ISBN: ${isbn13}\n\n` +
        bookUrl;

      for (const telegramChatId of chatIdsToNotify) {
        try {
          const options =
            telegramChatId === requestingChatId
              ? {
                  keyboard: mainKeyboard,
                  persistentKeyboard: true,
                }
              : undefined;

          await sendTelegramMessage(telegramChatId, notification, options);
        } catch (error) {
          const reason = error instanceof Error ? `: ${error.message}` : "";

          // One unreachable user must not block notifications to other users.
          console.error(
            `Unable to notify Telegram chat ${telegramChatId}${reason}`,
          );
        }
      }
    }
  }

  // The shared state is stored after all notification attempts.
  saveAvailability(source, isbn13, isAvailable);
}

/**
 * Adds a validated ISBN to one user's watchlist.
 */
async function addBookToWatchlist(
  telegramChatId: number,
  isbn13: string,
): Promise<void> {
  const addResult = addProductToWatchlist(
    telegramChatId,
    source,
    isbn13,
    maximumWatchesPerUser,
  );

  if (addResult === "already-watched") {
    await sendMainMenuMessage(
      telegramChatId,
      `ISBN already monitored: ${isbn13}`,
    );

    return;
  }

  if (addResult === "limit-reached") {
    await sendMainMenuMessage(
      telegramChatId,
      `You can monitor up to ${maximumWatchesPerUser} books.`,
    );

    return;
  }

  await sendTelegramMessage(
    telegramChatId,
    `ISBN added: ${isbn13}\nChecking Libraccio...`,
  );

  let libraccioBook;

  try {
    libraccioBook = await getLibraccioBookData(isbn13);
  } catch (error) {
    const reason = error instanceof Error ? `\n${error.message}` : "";

    await sendMainMenuMessage(
      telegramChatId,
      `The ISBN was added, but the first availability check ` +
        `could not be completed.${reason}`,
    );

    return;
  }

  if (libraccioBook.availability === "not-found") {
    // Removes only this user's watch when Libraccio has no corresponding page.
    removeProductFromWatchlist(telegramChatId, source, isbn13);

    await sendMainMenuMessage(
      telegramChatId,
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

  await saveAvailabilityAndNotifyIfNeeded(
    isbn13,
    libraccioBook.availability,
    telegramChatId,
  );

  if (libraccioBook.availability === "unavailable") {
    await sendMainMenuMessage(
      telegramChatId,
      "No used copy currently available on Libraccio.",
    );
  }
}

/**
 * Removes a validated ISBN from one user's watchlist.
 */
async function removeBookFromWatchlist(
  telegramChatId: number,
  isbn13: string,
): Promise<void> {
  const wasRemoved = removeProductFromWatchlist(telegramChatId, source, isbn13);

  if (wasRemoved) {
    await sendMainMenuMessage(telegramChatId, `ISBN removed: ${isbn13}`);
  } else {
    await sendMainMenuMessage(
      telegramChatId,
      `ISBN not found in your watchlist: ${isbn13}`,
    );
  }
}

/**
 * Validates an ISBN and executes one user's requested command.
 * Returns false when the ISBN is invalid.
 */
async function processIsbnCommand(
  telegramChatId: number,
  command: PendingCommand,
  isbnInput: string,
): Promise<boolean> {
  const isbn13 = validateAndConvertToIsbn13(isbnInput);

  if (isbn13 === undefined) {
    await sendTelegramMessage(
      telegramChatId,
      "The provided ISBN is not valid.",
    );

    return false;
  }

  if (command === "/watch") {
    await addBookToWatchlist(telegramChatId, isbn13);
  } else {
    await removeBookFromWatchlist(telegramChatId, isbn13);
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
 * Sends one user's compact watchlist.
 */
async function showWatchlist(telegramChatId: number): Promise<void> {
  const watchlist = getWatchlist(telegramChatId, source);

  if (watchlist.length === 0) {
    await sendMainMenuMessage(
      telegramChatId,
      "📚 You are not monitoring any books yet.\n\n" +
        "Use ➕ Add book or send /watch to add one.",
    );

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
      lines.push(`${item.editionYear} · ISBN ${item.productCode}`);
    } else {
      lines.push(`ISBN ${item.productCode}`);
    }

    if (item.lastCheckedAt === undefined) {
      lines.push("Used-copy check: never completed");
    } else {
      lines.push(
        `Used-copy check: ${formatUtcDateForItaly(item.lastCheckedAt)}`,
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

  await sendTelegramMessage(telegramChatId, message, {
    parseMode: "HTML",
    disableLinkPreview: true,
    keyboard: mainKeyboard,
    persistentKeyboard: true,
  });
}

/**
 * Interprets one text message from one Telegram chat.
 */
async function handleTelegramMessage(
  telegramChatId: number,
  text: string,
): Promise<void> {
  const receivedText = text.trim();

  // Button labels are translated before the normal command logic runs.
  const messageText = buttonCommands[receivedText] ?? receivedText;
  const pendingCommand = pendingCommands.get(telegramChatId);

  if (pendingCommand !== undefined) {
    if (messageText === "/cancel") {
      pendingCommands.delete(telegramChatId);

      await sendMainMenuMessage(telegramChatId, "Operation canceled.");

      return;
    }

    if (!messageText.startsWith("/")) {
      const isbnInput =
        pendingCommand === "/unwatch"
          ? getIsbnFromRemovalButton(messageText)
          : messageText;

      const wasIsbnValid = await processIsbnCommand(
        telegramChatId,
        pendingCommand,
        isbnInput,
      );

      if (wasIsbnValid) {
        pendingCommands.delete(telegramChatId);
      } else if (pendingCommand === "/watch") {
        await sendTelegramMessage(
          telegramChatId,
          "Send another ISBN or use /cancel.",
          {
            removeKeyboard: true,
          },
        );
      } else {
        await showRemoveBookKeyboard(
          telegramChatId,
          "That selection is not valid. Choose a book or cancel.",
        );
      }

      return;
    }

    // A new command interrupts only this user's current operation.
    pendingCommands.delete(telegramChatId);
  }

  const commandParts = messageText.split(/\s+/);
  const command = commandParts[0];

  // Joins the remaining parts so ISBNs containing spaces are accepted.
  const isbnInput = commandParts.slice(1).join("");

  if (command === "/start" || command === "/help") {
    await sendMainMenuMessage(telegramChatId, helpMessage);
  } else if (command === "/watch") {
    if (isbnInput === "") {
      pendingCommands.set(telegramChatId, "/watch");

      await sendTelegramMessage(
        telegramChatId,
        "Send me the ISBN of the book you want to monitor.\n\n/cancel",
        {
          removeKeyboard: true,
        },
      );
    } else {
      await processIsbnCommand(telegramChatId, "/watch", isbnInput);
    }
  } else if (command === "/unwatch") {
    if (isbnInput === "") {
      await showRemoveBookKeyboard(telegramChatId);
    } else {
      await processIsbnCommand(telegramChatId, "/unwatch", isbnInput);
    }
  } else if (command === "/list") {
    await showWatchlist(telegramChatId);
  } else if (command === "/cancel") {
    await sendMainMenuMessage(
      telegramChatId,
      "There is no operation to cancel.",
    );
  } else {
    await sendMainMenuMessage(
      telegramChatId,
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

        if (message?.text !== undefined && message.chat.type === "private") {
          const telegramChatId = message.chat.id;

          console.log(
            `Received Telegram message from ${telegramChatId}: ${message.text}`,
          );

          try {
            // Receiving any private message is enough to register the user.
            registerTelegramUser(telegramChatId);

            await handleTelegramMessage(telegramChatId, message.text);
          } catch (error) {
            const reason = error instanceof Error ? `: ${error.message}` : "";

            console.error(
              `Unable to handle Telegram message from ` +
                `${telegramChatId}${reason}`,
            );
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

    // Checks every ISBN once, regardless of how many users monitor it.
    for (const isbn13 of productsDueForCheck) {
      try {
        const libraccioBook = await getLibraccioBookData(isbn13);
        const storedProduct = getProductDetails(isbn13);

        // Reuses metadata from the availability request for older empty records.
        if (
          storedProduct?.title === undefined &&
          libraccioBook.metadata !== undefined
        ) {
          saveProductMetadata(isbn13, libraccioBook.metadata);

          console.log(`Metadata saved for ${isbn13} from Libraccio.`);
        }

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
