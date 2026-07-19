/**
 * Checks used-book availability on Libraccio.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 */

const libraccioBookUrl = "https://www.libraccio.it/libro";

/**
 * Sends an HTTP request to the Libraccio page for an ISBN.
 * The returned Promise will contain true when a used copy is available,
 * or false when both used-book identifiers are absent.
 */
export async function isUsedBookAvailableOnLibraccio(
  isbn13: string,
): Promise<boolean> {
  const url = `${libraccioBookUrl}/${isbn13}/book.html`;

  // Sends an HTTP GET request and waits for the Libraccio response.
  // Redirects to the complete book URL are followed automatically.
  const response = await fetch(url);

  // HTTP errors must not be mistaken for an unavailable used book.
  if (!response.ok) {
    throw new Error(`Libraccio returned HTTP status ${response.status}.`);
  }

  // Reads the response body and converts the downloaded HTML into a string.
  const html = await response.text();

  const hasUsedBuyLink = html.includes("bBuyULink");
  const hasUsedBuyClass = html.includes("acquista-usato");

  // One matching identifier is sufficient to report used availability.
  return hasUsedBuyLink || hasUsedBuyClass;
}
