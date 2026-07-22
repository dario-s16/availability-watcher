/**
 * Starts the command-line version of Availability Watcher.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 * Updated: 2026-07-22
 */

import {
  addProductToWatchlist,
  getWatchedProductCodes,
  removeProductFromWatchlist,
} from "./database.js";
import { validateAndConvertToIsbn13 } from "./isbn.js";
import { checkWatchedBook } from "./watcher.js";

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
    } else if (command === "check") {
      console.log(`Checking ISBN-13: ${isbn13}`);

      try {
        const isAvailable = await checkWatchedBook(isbn13);

        if (isAvailable) {
          console.log("Used copy available on Libraccio.");
        } else {
          console.log("No used copy currently available on Libraccio.");
        }
      } catch (error) {
        if (error instanceof Error) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error("Error: Unable to complete the availability check.");
        }

        process.exitCode = 1;
      }
    }
  }
} else {
  console.error("Error: Please provide a valid command.");
  printUsage();
  process.exitCode = 1;
}
