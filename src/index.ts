/**
 * Starts the command-line version of Availability Watcher.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 */

import { getPreviousAvailability, saveAvailability } from "./database.js";
import { validateAndConvertToIsbn13 } from "./isbn.js";
import { isUsedBookAvailableOnLibraccio } from "./libraccio.js";
import { sendTelegramMessage } from "./telegram.js";

// Identifies the store inside the database.
const source = "libraccio";

// Reads the first argument supplied by the user.
// Positions 0 and 1 contain the Node executable and the script path.
const isbnInput = process.argv[2];

if (isbnInput === undefined) {
  console.error("Error: Please provide an ISBN.");
  console.error("Usage: npm start -- <ISBN>");

  // Reports that the program ended with an error.
  process.exitCode = 1;
} else {
  // Validates the input and converts a valid ISBN-10 to ISBN-13.
  const isbn13 = validateAndConvertToIsbn13(isbnInput);

  if (isbn13 === undefined) {
    console.error("Error: The provided ISBN is not valid.");
    process.exitCode = 1;
  } else {
    console.log(`ISBN-13: ${isbn13}`);

    try {
      // Waits for Libraccio to return the current availability.
      const isUsedAvailable = await isUsedBookAvailableOnLibraccio(isbn13);

      // Reads the last availability saved for this store and ISBN.
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

          // Waits until Telegram confirms that the message was sent.
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
}
