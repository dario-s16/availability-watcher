/**
 * Checks used-book availability on Libraccio.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 * Updated: 2026-07-25
 */

const libraccioBookUrl = "https://www.libraccio.it/libro";

export type LibraccioAvailability = "available" | "unavailable" | "not-found";

/**
 * Checks whether Libraccio has a page and a used copy for an ISBN.
 * Network and unexpected HTTP errors are reported as exceptions.
 */
export async function checkUsedBookAvailabilityOnLibraccio(
  isbn13: string,
): Promise<LibraccioAvailability> {
  const requestedUrl = `${libraccioBookUrl}/${isbn13}/book.html`;

  // Sends an HTTP GET request and follows redirects automatically.
  const response = await fetch(requestedUrl);

  // A 404 means that Libraccio has no page for this ISBN.
  if (response.status === 404) {
    return "not-found";
  }

  // Other HTTP errors must not be mistaken for product availability.
  if (!response.ok) {
    throw new Error(`Libraccio returned HTTP status ${response.status}.`);
  }

  // Converts the downloaded HTML response into searchable text.
  const html = await response.text();

  const hasExpectedUrl = response.url.startsWith(
    `${libraccioBookUrl}/${isbn13}/`,
  );
  const hasExpectedIsbn = html.includes(isbn13);
  const hasProductStructure =
    html.includes("C_C_ProductDetail") || html.includes("product-detail");

  // Prevents an unexpected page from being saved as unavailable.
  if (!hasExpectedUrl || !hasExpectedIsbn || !hasProductStructure) {
    throw new Error("Libraccio returned an unexpected product page.");
  }

  const hasUsedBuyLink = html.includes("bBuyULink");
  const hasUsedBuyClass = html.includes("acquista-usato");

  // One matching identifier is sufficient to report used availability.
  if (hasUsedBuyLink || hasUsedBuyClass) {
    return "available";
  }

  return "unavailable";
}
