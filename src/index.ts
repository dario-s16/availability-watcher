/**
 * Starts the command-line version of Availability Watcher.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 */

import { validateAndConvertToIsbn13 } from "./isbn.js";
import { isUsedBookAvailableOnLibraccio } from "./libraccio.js";

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
      } else {
        console.log("No used copy currently available on Libraccio.");
      }
    } catch (error) {
      // Network and HTTP errors are different from unavailable books.
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
      } else {
        console.error("Error: Unable to check Libraccio.");
      }

      process.exitCode = 1;
    }
  }
}
