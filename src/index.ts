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
  maximumActiveUsers,
  maximumUniqueBooks,
  maximumWatchesPerUser,
} from "./config.js";
import {
  addProductToWatchlist,
  createDatabaseBackup,
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
  getIsbnFromLibraccioUrl,
  getLibraccioBookData,
  searchLibraccioBooks,
  type LibraccioBookData,
  type LibraccioBookSearchResult,
} from "./libraccio.js";
import { getTelegramUpdates, sendTelegramMessage } from "./telegram.js";

type PendingCommand = "/watch" | "/unwatch";

interface BookAddRateLimit {
  attemptCount: number;
  startedAt: number;
}

const source = "libraccio";

const checkIntervalMinutes = 30;
const checkIntervalMilliseconds = checkIntervalMinutes * 60 * 1000;

const requestDelaySeconds = 3;
const requestDelayMilliseconds = requestDelaySeconds * 1000;

const telegramRetryDelaySeconds = 5;
const telegramRetryDelayMilliseconds = telegramRetryDelaySeconds * 1000;

const maximumBookAddAttempts = 10;
const bookAddRateLimitWindowMilliseconds = 60 * 1000;

const databaseBackupIntervalHours = 24;
const databaseBackupIntervalMilliseconds =
  databaseBackupIntervalHours * 60 * 60 * 1000;
const maximumDatabaseBackups = 30;

// Telegram accepts at most 4096 characters in one message.
const maximumTelegramMessageLength = 4000;

const addBookButton = "➕ Aggiungi libro";
const listBooksButton = "📚 Libri monitorati";
const removeBookButton = "🗑 Rimuovi libro";
const helpButton = "❓ Aiuto";
const cancelButton = "✖ Annulla";

// This keyboard provides the main actions on mobile.
const mainKeyboard = [
  [listBooksButton, helpButton],
  [addBookButton, removeBookButton],
];

// Converts friendly button labels into the existing slash commands.
const buttonCommands: Record<string, string> = {
  [addBookButton]: "/watch",
  [listBooksButton]: "/list",
  [removeBookButton]: "/unwatch",
  [helpButton]: "/help",
  [cancelButton]: "/cancel",
};

const startMessage =
  "📚 Benvenuto in Monitor Usato Libraccio!\n\n" +
  "Controllo la disponibilità dei libri usati su Libraccio e ti avviso " +
  "quando una copia diventa disponibile.\n\n" +
  "Usa i pulsanti qui sotto per aggiungere un libro tramite ISBN, link " +
  "Libraccio o titolo, visualizzare la tua lista o rimuovere un libro. " +
  `Apri ${helpButton} per maggiori informazioni.`;

const helpMessage =
  "❓ Comandi\n\n" +
  `• ${addBookButton} o /watch — aggiungi un libro tramite ISBN, link Libraccio o titolo\n` +
  `• ${listBooksButton} o /list — mostra i libri monitorati\n` +
  `• ${removeBookButton} o /unwatch — rimuovi un libro\n` +
  `• ${cancelButton} o /cancel — annulla l'operazione corrente\n\n` +
  `La disponibilità dell'usato viene controllata circa ogni ` +
  `${checkIntervalMinutes} minuti.\n\n` +
  "🔒 Privacy\n" +
  "Il bot conserva il tuo Chat ID e gli ISBN monitorati soltanto per " +
  "fornire il servizio. La tua lista non è visibile agli altri utenti.\n\n" +
  "Per assistenza o per richiedere la cancellazione dei dati: " +
  "monitorusatolibraccio@outlook.com\n\n" +
  "Bot indipendente e non ufficiale.";

// Stores one pending command for each Telegram chat.
// These temporary values reset when the application restarts.
const pendingCommands = new Map<number, PendingCommand>();

// Stores title-search results while one user is choosing an edition.
const pendingBookSearchResults = new Map<number, LibraccioBookSearchResult[]>();

/**
 * Clears every temporary operation associated with one Telegram chat.
 */
function clearPendingOperation(telegramChatId: number): void {
  pendingCommands.delete(telegramChatId);
  pendingBookSearchResults.delete(telegramChatId);
}

// Stores the current book-add rate limit for each Telegram chat.
const bookAddRateLimits = new Map<number, BookAddRateLimit>();

/**
 * Registers a valid book-add attempt and returns whether it is allowed.
 */
function registerBookAddAttempt(telegramChatId: number): boolean {
  const now = Date.now();
  const currentLimit = bookAddRateLimits.get(telegramChatId);

  if (
    currentLimit === undefined ||
    now - currentLimit.startedAt >= bookAddRateLimitWindowMilliseconds
  ) {
    bookAddRateLimits.set(telegramChatId, {
      attemptCount: 1,
      startedAt: now,
    });

    return true;
  }

  if (currentLimit.attemptCount >= maximumBookAddAttempts) {
    return false;
  }

  currentLimit.attemptCount += 1;

  return true;
}

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
  message = "Scegli il libro che vuoi rimuovere.",
): Promise<void> {
  const watchlist = getWatchlist(telegramChatId, source);

  if (watchlist.length === 0) {
    clearPendingOperation(telegramChatId);

    await sendMainMenuMessage(
      telegramChatId,
      "📚 Non stai ancora monitorando nessun libro.\n\n" +
        "Usa ➕ Aggiungi libro oppure /watch per aggiungerne uno.",
    );

    return;
  }

  // Cancel remains the first and easiest action to reach.
  const removeKeyboard = [[cancelButton]];

  for (const item of watchlist) {
    const title = shortenBookTitle(item.title ?? "Titolo non disponibile");

    removeKeyboard.push([`${title} [${item.productCode}]`]);
  }

  pendingBookSearchResults.delete(telegramChatId);

  pendingCommands.set(telegramChatId, "/unwatch");

  await sendTelegramMessage(telegramChatId, message, {
    keyboard: removeKeyboard,
    oneTimeKeyboard: true,
  });
}

/**
 * Saves global availability and notifies interested users.
 * The requesting Chat ID is used only for manual additions.
 */
async function saveAvailabilityAndNotifyIfNeeded(
  isbn13: string,
  libraccioBook: LibraccioBookData,
  requestingChatId?: number,
): Promise<void> {
  const { availability, newPriceInCents, usedPriceInCents } = libraccioBook;

  // A missing page is not an availability state to save.
  if (availability === "not-found") {
    return;
  }

  const isAvailable = availability === "available";
  const previousAvailability = getPreviousAvailability(source, isbn13);

  // A transition to available interests every existing watcher.
  if (isAvailable && previousAvailability !== true) {
    const chatIdsToNotify = getTelegramChatIdsWatchingProduct(
      source,
      isbn13,
    ).filter((telegramChatId) => telegramChatId !== requestingChatId);

    if (chatIdsToNotify.length > 0) {
      const product = getProductDetails(isbn13);
      const title = product?.title ?? "non disponibile";
      const authors = product?.authors ?? "non disponibili";
      const bookUrl = `https://www.libraccio.it/libro/${isbn13}/book.html`;

      const notificationLines = [
        "✅ Copia usata disponibile su Libraccio!",
        "",
        `Titolo: ${title}`,
        `Autori: ${authors}`,
        `ISBN: ${isbn13}`,
      ];

      if (newPriceInCents !== undefined) {
        notificationLines.push(
          `Prezzo nuovo: ${formatPriceInEuros(newPriceInCents)}`,
        );
      }

      if (usedPriceInCents !== undefined) {
        notificationLines.push(
          `Prezzo usato: ${formatPriceInEuros(usedPriceInCents)}`,
        );
      }

      notificationLines.push("", bookUrl);

      const notification = notificationLines.join("\n");

      for (const telegramChatId of chatIdsToNotify) {
        try {
          await sendTelegramMessage(telegramChatId, notification);
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
  saveAvailability(
    source,
    isbn13,
    isAvailable,
    newPriceInCents,
    usedPriceInCents,
  );
}

/**
 * Confirms which book was added and shows its current used availability.
 */
async function sendBookAddedConfirmation(
  telegramChatId: number,
  isbn13: string,
  libraccioBook: LibraccioBookData,
): Promise<void> {
  const { availability, newPriceInCents, usedPriceInCents } = libraccioBook;
  const isAvailable = availability === "available";
  const product = getProductDetails(isbn13);
  const title = product?.title ?? "Titolo non disponibile";
  const bookUrl = `https://www.libraccio.it/libro/${isbn13}/book.html`;

  const lines = ["✅ Libro aggiunto alla tua lista.", "", `📖 ${title}`];

  if (product?.authors !== undefined) {
    lines.push(`Autori: ${product.authors}`);
  }

  lines.push(
    `ISBN: ${isbn13}`,
    `Copia usata: ${isAvailable ? "✅ disponibile ora" : "❌ non disponibile"}`,
  );

  if (newPriceInCents !== undefined) {
    lines.push(`Prezzo nuovo: ${formatPriceInEuros(newPriceInCents)}`);
  }

  if (usedPriceInCents !== undefined) {
    lines.push(`Prezzo usato: ${formatPriceInEuros(usedPriceInCents)}`);
  }

  lines.push("");

  if (isAvailable) {
    lines.push("🔔 Continuerò a monitorare questo libro.");
  } else {
    lines.push("🔔 Ti avviserò quando una copia usata sarà disponibile.");
  }

  lines.push("", bookUrl);

  await sendMainMenuMessage(telegramChatId, lines.join("\n"));
}

/**
 * Adds a validated ISBN to one user's watchlist.
 */
async function addBookToWatchlist(
  telegramChatId: number,
  isbn13: string,
  selectedBook?: LibraccioBookSearchResult,
): Promise<void> {
  const addResult = addProductToWatchlist(telegramChatId, source, isbn13, {
    maximumActiveUsers,
    maximumWatchesPerUser,
    maximumUniqueBooks,
  });

  if (addResult === "already-watched") {
    await sendMainMenuMessage(
      telegramChatId,
      `Questo ISBN è già nella tua lista: ${isbn13}`,
    );

    return;
  }

  if (addResult === "watch-limit-reached") {
    await sendMainMenuMessage(
      telegramChatId,
      `Puoi monitorare al massimo ${maximumWatchesPerUser} libri.`,
    );

    return;
  }

  if (addResult === "user-limit-reached") {
    await sendMainMenuMessage(
      telegramChatId,
      "Il servizio ha raggiunto il limite di " +
        `${maximumActiveUsers} utenti attivi e al momento non può accettare ` +
        "nuovi utenti.",
    );

    return;
  }

  if (addResult === "book-limit-reached") {
    await sendMainMenuMessage(
      telegramChatId,
      "Il servizio sta già monitorando il numero massimo di " +
        `${maximumUniqueBooks} libri diversi. Riprova più tardi.`,
    );

    return;
  }

  if (selectedBook !== undefined) {
    saveProductMetadata(isbn13, {
      title: selectedBook.title,
      authors: selectedBook.authors,
      editionYear: selectedBook.editionYear,
      publisher: selectedBook.publisher,
      source: "libraccio",
    });
  }

  await sendTelegramMessage(
    telegramChatId,
    `🔄 Controllo l'ISBN ${isbn13} su Libraccio...`,
  );

  let libraccioBook;

  try {
    libraccioBook = await getLibraccioBookData(isbn13);
  } catch (error) {
    const reason = error instanceof Error ? `: ${error.message}` : "";

    console.error(
      `Unable to complete the first Libraccio check for ${isbn13}${reason}`,
    );

    await sendMainMenuMessage(
      telegramChatId,
      "⚠️ Il libro è stato salvato, ma non è stato possibile completare " +
        "il primo controllo su Libraccio.\n\n" +
        `ISBN: ${isbn13}\n\n` +
        "I controlli automatici riproveranno.",
    );

    return;
  }

  if (libraccioBook.availability === "not-found") {
    // Removes only this user's watch when Libraccio has no corresponding page.
    removeProductFromWatchlist(telegramChatId, source, isbn13);

    await sendMainMenuMessage(
      telegramChatId,
      `⚠️ Libraccio non ha una pagina per l'ISBN ${isbn13}.\n\n` +
        "Il libro non è stato aggiunto alla tua lista.",
    );

    return;
  }

  // APIs are preferred, while Libraccio completes any missing fields.
  const metadata = await getBookMetadata(
    isbn13,
    selectedBook === undefined
      ? libraccioBook.metadata
      : {
          title: selectedBook.title,
          authors: selectedBook.authors,
          editionYear: selectedBook.editionYear,
          publisher: selectedBook.publisher,
          source: "libraccio",
        },
  );

  if (metadata === undefined) {
    console.log(`No metadata found for ${isbn13}.`);
  } else {
    saveProductMetadata(isbn13, metadata);

    console.log(`Metadata saved for ${isbn13} from ${metadata.source}.`);
  }

  await saveAvailabilityAndNotifyIfNeeded(
    isbn13,
    libraccioBook,
    telegramChatId,
  );

  await sendBookAddedConfirmation(telegramChatId, isbn13, libraccioBook);
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
    const product = getProductDetails(isbn13);
    const title = product?.title ?? "Titolo non disponibile";

    await sendMainMenuMessage(
      telegramChatId,
      "🗑 Libro rimosso dalla tua lista.\n\n" +
        `📖 ${title}\n` +
        `ISBN: ${isbn13}`,
    );
  } else {
    await sendMainMenuMessage(
      telegramChatId,
      `ISBN non presente nella tua lista: ${isbn13}`,
    );
  }
}

/**
 * Resolves an ISBN or Libraccio URL and executes one user's command.
 * Returns false when the input does not contain a valid ISBN.
 */
async function processIsbnCommand(
  telegramChatId: number,
  command: PendingCommand,
  input: string,
): Promise<boolean> {
  const isbn13 =
    validateAndConvertToIsbn13(input) ?? getIsbnFromLibraccioUrl(input);

  if (isbn13 === undefined) {
    await sendTelegramMessage(
      telegramChatId,
      "L'ISBN o il link Libraccio fornito non è valido.",
    );

    return false;
  }

  if (command === "/watch") {
    const isAttemptAllowed = registerBookAddAttempt(telegramChatId);

    if (!isAttemptAllowed) {
      await sendMainMenuMessage(
        telegramChatId,
        "Hai effettuato troppi tentativi di aggiunta in poco tempo. " +
          "Riprova tra qualche secondo.",
      );

      return true;
    }

    await addBookToWatchlist(telegramChatId, isbn13);
  } else {
    await removeBookFromWatchlist(telegramChatId, isbn13);
  }

  return true;
}

/**
 * Formats one Libraccio edition for the Telegram selection message.
 */
function formatBookSearchResult(
  result: LibraccioBookSearchResult,
  index: number,
): string {
  const details = [
    result.authors,
    result.editionYear?.toString(),
    result.publisher,
  ].filter((value): value is string => value !== undefined);

  const lines = [`${index + 1}. ${result.title}`];

  if (details.length > 0) {
    lines.push(details.join(" · "));
  }

  lines.push(`ISBN ${result.isbn13}`);

  return lines.join("\n");
}

/**
 * Shows the editions found on Libraccio using numbered Telegram buttons.
 */
async function showBookSearchResults(
  telegramChatId: number,
  results: LibraccioBookSearchResult[],
  message = "Scegli l'edizione che vuoi monitorare.",
): Promise<void> {
  const numberButtons = results.map((_, index) => String(index + 1));
  const searchKeyboard: string[][] = [];

  for (let index = 0; index < numberButtons.length; index += 2) {
    searchKeyboard.push(numberButtons.slice(index, index + 2));
  }

  searchKeyboard.push([cancelButton]);

  pendingCommands.set(telegramChatId, "/watch");
  pendingBookSearchResults.set(telegramChatId, results);

  const formattedResults = results
    .map((result, index) => formatBookSearchResult(result, index))
    .join("\n\n");

  await sendTelegramMessage(
    telegramChatId,
    `${message}\n\n${formattedResults}`,
    {
      keyboard: searchKeyboard,
      oneTimeKeyboard: true,
    },
  );
}

/**
 * Searches Libraccio for a title and asks the user to choose an edition.
 */
async function searchBooksByTitle(
  telegramChatId: number,
  input: string,
): Promise<void> {
  const query = input.trim();

  pendingCommands.set(telegramChatId, "/watch");
  pendingBookSearchResults.delete(telegramChatId);

  if (query.length < 2 || query.length > 100) {
    await sendTelegramMessage(
      telegramChatId,
      "Il titolo deve contenere da 2 a 100 caratteri.\n\n" +
        "Invia un altro titolo oppure usa /cancel.",
      {
        removeKeyboard: true,
      },
    );

    return;
  }

  const isAttemptAllowed = registerBookAddAttempt(telegramChatId);

  if (!isAttemptAllowed) {
    clearPendingOperation(telegramChatId);

    await sendMainMenuMessage(
      telegramChatId,
      "Hai effettuato troppi tentativi di aggiunta in poco tempo. " +
        "Riprova tra qualche secondo.",
    );

    return;
  }

  await sendTelegramMessage(
    telegramChatId,
    `🔎 Cerco “${query}” nel catalogo Libraccio...`,
  );

  let results: LibraccioBookSearchResult[];

  try {
    results = await searchLibraccioBooks(query);
  } catch (error) {
    const reason = error instanceof Error ? `: ${error.message}` : "";

    console.error(`Unable to search Libraccio for "${query}"${reason}`);

    await sendTelegramMessage(
      telegramChatId,
      "⚠️ Non è stato possibile completare la ricerca su Libraccio.\n\n" +
        "Invia un altro titolo oppure usa /cancel.",
      {
        removeKeyboard: true,
      },
    );

    return;
  }

  if (results.length === 0) {
    await sendTelegramMessage(
      telegramChatId,
      "Non ho trovato edizioni corrispondenti nel catalogo Libraccio.\n\n" +
        "Prova con un altro titolo oppure usa /cancel.",
      {
        removeKeyboard: true,
      },
    );

    return;
  }

  await showBookSearchResults(telegramChatId, results);
}

/**
 * Processes an ISBN, Libraccio URL, or book title during an addition.
 */
async function processAddBookInput(
  telegramChatId: number,
  input: string,
): Promise<void> {
  const isbn13 =
    validateAndConvertToIsbn13(input) ?? getIsbnFromLibraccioUrl(input);

  if (isbn13 === undefined) {
    await searchBooksByTitle(telegramChatId, input);

    return;
  }

  const wasProcessed = await processIsbnCommand(
    telegramChatId,
    "/watch",
    isbn13,
  );

  if (wasProcessed) {
    clearPendingOperation(telegramChatId);
  }
}

/**
 * Adds the edition selected from the current title-search results.
 */
async function processBookSearchSelection(
  telegramChatId: number,
  input: string,
  results: LibraccioBookSearchResult[],
): Promise<void> {
  const selectedNumber = Number(input);
  const selectedBook =
    Number.isInteger(selectedNumber) && selectedNumber >= 1
      ? results[selectedNumber - 1]
      : undefined;

  if (selectedBook === undefined) {
    await showBookSearchResults(
      telegramChatId,
      results,
      "Scelta non valida. Usa uno dei pulsanti oppure annulla.",
    );

    return;
  }

  clearPendingOperation(telegramChatId);

  await addBookToWatchlist(telegramChatId, selectedBook.isbn13, selectedBook);
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
 * Formats integer euro cents for Italian messages.
 */
function formatPriceInEuros(priceInCents: number): string {
  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency: "EUR",
  }).format(priceInCents / 100);
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
      "📚 Non stai ancora monitorando nessun libro.\n\n" +
        "Usa ➕ Aggiungi libro oppure /watch per aggiungerne uno.",
    );

    return;
  }

  // Shows books with an available used copy before all other books.
  watchlist.sort((firstBook, secondBook) => {
    const firstBookIsAvailable = firstBook.isAvailable === true ? 1 : 0;
    const secondBookIsAvailable = secondBook.isAvailable === true ? 1 : 0;

    return secondBookIsAvailable - firstBookIsAvailable;
  });

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
    const title = escapeTelegramHtml(item.title ?? "Titolo non disponibile");

    const authors =
      item.authors === undefined ? undefined : escapeTelegramHtml(item.authors);

    const availabilityIcon =
      item.isAvailable === undefined ? "❔" : item.isAvailable ? "✅" : "❌";

    const bookUrl =
      `https://www.libraccio.it/libro/` + `${item.productCode}/book.html`;

    const lines = [`${availabilityIcon} <a href="${bookUrl}">${title}</a>`];

    if (authors !== undefined) {
      lines.push(`Autori: ${authors}`);
    }

    const priceParts: string[] = [];

    if (item.newPriceInCents !== undefined) {
      priceParts.push(`Nuovo ${formatPriceInEuros(item.newPriceInCents)}`);
    }

    if (item.usedPriceInCents !== undefined) {
      priceParts.push(`Usato ${formatPriceInEuros(item.usedPriceInCents)}`);
    }

    if (priceParts.length > 0) {
      lines.push(priceParts.join(" · "));
    }

    if (item.editionYear !== undefined) {
      lines.push(`${item.editionYear} · ISBN ${item.productCode}`);
    } else {
      lines.push(`ISBN ${item.productCode}`);
    }

    if (item.lastCheckedAt === undefined) {
      lines.push("Ultimo controllo: mai completato");
    } else {
      lines.push(
        `Ultimo controllo: ${formatUtcDateForItaly(item.lastCheckedAt)}`,
      );
    }

    return lines.join("\n");
  });

  const availabilitySummary = [
    `✅ ${availableCount} disponibili`,
    `❌ ${unavailableCount} non disponibili`,
  ];

  if (unknownCount > 0) {
    availabilitySummary.push(`❔ ${unknownCount} sconosciute`);
  }

  const header =
    `📚 Libri monitorati: ${watchlist.length}\n` +
    `Copie usate: ${availabilitySummary.join(" · ")}`;

  const messages: string[] = [];
  let currentMessage = header;

  for (const book of books) {
    const extendedMessage = `${currentMessage}\n\n${book}`;

    if (extendedMessage.length <= maximumTelegramMessageLength) {
      currentMessage = extendedMessage;
    } else {
      messages.push(currentMessage);
      currentMessage = book;
    }
  }

  messages.push(currentMessage);

  for (const message of messages) {
    await sendTelegramMessage(telegramChatId, message, {
      parseMode: "HTML",
      disableLinkPreview: true,
      keyboard: mainKeyboard,
      persistentKeyboard: true,
    });
  }
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
      clearPendingOperation(telegramChatId);

      await sendMainMenuMessage(telegramChatId, "Operazione annullata.");

      return;
    }

    if (!messageText.startsWith("/")) {
      if (pendingCommand === "/watch") {
        const searchResults = pendingBookSearchResults.get(telegramChatId);

        if (searchResults === undefined) {
          await processAddBookInput(telegramChatId, messageText);
        } else {
          await processBookSearchSelection(
            telegramChatId,
            messageText,
            searchResults,
          );
        }

        return;
      }

      const isbnInput = getIsbnFromRemovalButton(messageText);
      const wasIsbnValid = await processIsbnCommand(
        telegramChatId,
        "/unwatch",
        isbnInput,
      );

      if (wasIsbnValid) {
        clearPendingOperation(telegramChatId);
      } else {
        await showRemoveBookKeyboard(
          telegramChatId,
          "Scelta non valida. Scegli un libro oppure annulla.",
        );
      }

      return;
    }

    // A new command interrupts only this user's current operation.
    clearPendingOperation(telegramChatId);
  }

  const commandParts = messageText.split(/\s+/);
  const command = commandParts[0];

  // Preserves title words; ISBN validation already ignores spaces.
  const commandInput = commandParts.slice(1).join(" ");

  if (command === "/start") {
    await sendMainMenuMessage(telegramChatId, startMessage);
  } else if (command === "/help") {
    await sendMainMenuMessage(telegramChatId, helpMessage);
  } else if (command === "/watch") {
    if (commandInput === "") {
      pendingBookSearchResults.delete(telegramChatId);
      pendingCommands.set(telegramChatId, "/watch");

      await sendTelegramMessage(
        telegramChatId,
        "Inviami l'ISBN, il link Libraccio o il titolo del libro che vuoi " +
          "monitorare.\n\n/cancel",
        {
          removeKeyboard: true,
        },
      );
    } else {
      await processAddBookInput(telegramChatId, commandInput);
    }
  } else if (command === "/unwatch") {
    if (commandInput === "") {
      await showRemoveBookKeyboard(telegramChatId);
    } else {
      await processIsbnCommand(telegramChatId, "/unwatch", commandInput);
    }
  } else if (command === "/list") {
    await showWatchlist(telegramChatId);
  } else if (command === "/cancel") {
    await sendMainMenuMessage(
      telegramChatId,
      "Non c'è nessuna operazione da annullare.",
    );
  } else {
    await sendMainMenuMessage(
      telegramChatId,
      "Comando non riconosciuto. Invia /help per vedere i comandi disponibili.",
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

        await saveAvailabilityAndNotifyIfNeeded(isbn13, libraccioBook);

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

/**
 * Creates and retains periodic database backups.
 */
async function runDatabaseBackups(): Promise<void> {
  while (true) {
    try {
      const backupPath = await createDatabaseBackup(maximumDatabaseBackups);

      console.log(`Database backup created: ${backupPath}`);
    } catch (error) {
      const reason = error instanceof Error ? `: ${error.message}` : "";

      console.error(`Unable to create database backup${reason}`);
    }

    await setTimeout(databaseBackupIntervalMilliseconds);
  }
}

console.log("Availability Watcher is running.");

// Keeps Telegram, availability checks, and database backups running together.
await Promise.all([
  runTelegramBot(),
  runPeriodicChecks(),
  runDatabaseBackups(),
]);
