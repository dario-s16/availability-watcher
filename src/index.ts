/**
 * Starts the command-line version of Availability Watcher.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 */

import {
  addProductToWatchlist,
  getPreviousAvailability,
  getWatchedProductCodes,
  removeProductFromWatchlist,
  saveAvailability,
} from "./database.js";
import { validateAndConvertToIsbn13 } from "./isbn.js";
import { isUsedBookAvailableOnLibraccio } from "./libraccio.js";
import { sendTelegramMessage } from "./telegram.js";

// Identifies the store inside the database.
const source = "libraccio";

/**
 * Shows the available terminal commands.
 */
function printUsage(): void {
  console.log("Available commands:");
  console.log("  npm start -- watch <ISBN>");
  console.log("  npm start -- unwatch <ISBN>");
  console.log("  npm start -- list");
  console.log("  npm start -- check <ISBN>");
}

/**
 * Checks the current availability and sends a notification when needed.
 */
async function checkBookAvailability(isbn13: string): Promise<void> {
  try {
    const isUsedAvailable = await isUsedBookAvailableOnLibraccio(isbn13);

    const previousAvailability = getPreviousAvailability(source, isbn13);

    // Notifies when the book is available and was not already available.
    const shouldNotify = isUsedAvailable && previousAvailability !== true;

    if (isUsedAvailable) {
      console.log("Used copy available on Libraccio.");

      if (shouldNotify) {
        const bookUrl = `https://www.libraccio.it/libro/${isbn13}/book.html`;

        const message =
          `Used copy available on Libraccio!\n` +
          `ISBN-13: ${isbn13}\n` +
          bookUrl;

        await sendTelegramMessage(message);

        console.log("Telegram notification sent.");
      } else {
        console.log("Telegram notification not needed.");
      }
    } else {
      console.log("No used copy currently available on Libraccio.");
    }

    // Saves the current result after the check and notification succeed.
    saveAvailability(source, isbn13, isUsedAvailable);
  } catch (error) {
    // Network, database and Telegram errors are not availability results.
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("Error: Unable to complete the availability check.");
    }

    process.exitCode = 1;
  }
}

// Position 2 contains the command and position 3 contains the ISBN.
const command = process.argv[2];
const isbnInput = process.argv[3];

if (command === "list") {
  const watchedProducts = getWatchedProductCodes(source);

  if (watchedProducts.length === 0) {
    console.log("The watchlist is empty.");
  } else {
    console.log("Monitored ISBNs:");

    // Prints every ISBN contained in the watchlist.
    for (const productCode of watchedProducts) {
      console.log(`- ${productCode}`);
    }
  }
} else if (
  command === "watch" ||
  command === "unwatch" ||
  command === "check"
) {
  if (isbnInput === undefined) {
    console.error(`Error: The ${command} command requires an ISBN.`);
    printUsage();
    process.exitCode = 1;
  } else {
    const isbn13 = validateAndConvertToIsbn13(isbnInput);

    if (isbn13 === undefined) {
      console.error("Error: The provided ISBN is not valid.");
      process.exitCode = 1;
    } else if (command === "watch") {
      const wasAdded = addProductToWatchlist(source, isbn13);

      if (wasAdded) {
        console.log(`ISBN added to the watchlist: ${isbn13}`);
      } else {
        console.log(`ISBN already in the watchlist: ${isbn13}`);
      }
    } else if (command === "unwatch") {
      const wasRemoved = removeProductFromWatchlist(source, isbn13);

      if (wasRemoved) {
        console.log(`ISBN removed from the watchlist: ${isbn13}`);
      } else {
        console.log(`ISBN not found in the watchlist: ${isbn13}`);
      }
    } else {
      console.log(`Checking ISBN-13: ${isbn13}`);
      await checkBookAvailability(isbn13);
    }
  }
} else {
  console.error("Error: Please provide a valid command.");
  printUsage();
  process.exitCode = 1;
}
