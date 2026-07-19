/**
 * Starts the command-line version of Availability Watcher.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 */

import { validateAndConvertToIsbn13 } from "./isbn.js";
import { isUsedBookAvailableOnLibraccio } from "./libraccio.js";
import { sendTelegramMessage } from "./telegram.js";

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
      // Waits for Libraccio to return the availability result.
      const isUsedAvailable = await isUsedBookAvailableOnLibraccio(isbn13);

      if (isUsedAvailable) {
        console.log("Used copy available on Libraccio.");

        const bookUrl = `https://www.libraccio.it/libro/${isbn13}/book.html`;

        const message =
          `Used copy available on Libraccio!\n` +
          `ISBN-13: ${isbn13}\n` +
          bookUrl;

        // Waits until Telegram confirms that the message was sent.
        await sendTelegramMessage(message);

        console.log("Telegram notification sent.");
      } else {
        console.log("No used copy currently available on Libraccio.");
      }
    } catch (error) {
      // Network and HTTP errors are different from unavailable books.
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
      } else {
        console.error("Error: Unable to complete the availability check.");
      }

      process.exitCode = 1;
    }
  }
}
