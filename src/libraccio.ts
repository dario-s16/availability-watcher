/**
 * Retrieves used-book availability and book information from Libraccio.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 * Updated: 2026-07-26
 */

import type { BookMetadata } from "./book-metadata.js";

const libraccioBookUrl = "https://www.libraccio.it/libro";
const libraccioRequestTimeoutMilliseconds = 15000;

export type LibraccioAvailability = "available" | "unavailable" | "not-found";

export interface LibraccioBookData {
  availability: LibraccioAvailability;
  metadata: BookMetadata | undefined;
}

interface LibraccioJsonLd {
  "@type"?: string | string[];
  name?: string;
  isbn?: string;
  author?:
    | {
        name?: string;
      }
    | Array<{
        name?: string;
      }>;
}

/**
 * Reads title and authors from Libraccio JSON-LD for the exact ISBN.
 */
function getLibraccioMetadata(
  html: string,
  isbn13: string,
): BookMetadata | undefined {
  const jsonLdBlocks = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const block of jsonLdBlocks) {
    const jsonText = block[1];

    if (jsonText === undefined) {
      continue;
    }

    try {
      const data = JSON.parse(jsonText) as LibraccioJsonLd;
      const types = Array.isArray(data["@type"])
        ? data["@type"]
        : [data["@type"]];

      // Accepts only a book containing the exact requested ISBN.
      if (
        !types.includes("Book") ||
        data.isbn !== isbn13 ||
        data.name === undefined
      ) {
        continue;
      }

      const authorEntries =
        data.author === undefined
          ? []
          : Array.isArray(data.author)
            ? data.author
            : [data.author];

      const authorNames = authorEntries
        .map((author) => author.name)
        .filter((name): name is string => name !== undefined);

      return {
        title: data.name,
        authors: authorNames.length === 0 ? undefined : authorNames.join(", "),
        editionYear: undefined,
        publisher: undefined,
        source: "libraccio",
      };
    } catch {
      // Invalid JSON-LD must not interrupt the availability check.
      continue;
    }
  }

  return undefined;
}

/**
 * Retrieves a Libraccio page, used availability, and optional book metadata.
 * Network and unexpected HTTP errors are reported as exceptions.
 */
export async function getLibraccioBookData(
  isbn13: string,
): Promise<LibraccioBookData> {
  const requestedUrl = `${libraccioBookUrl}/${isbn13}/book.html`;

  // Stops the request if Libraccio does not respond within 15 seconds.
  const response = await fetch(requestedUrl, {
    signal: AbortSignal.timeout(libraccioRequestTimeoutMilliseconds),
  });

  // A 404 means that Libraccio has no page for this ISBN.
  if (response.status === 404) {
    return {
      availability: "not-found",
      metadata: undefined,
    };
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

  // Prevents an unexpected page from being treated as a valid product.
  if (!hasExpectedUrl || !hasExpectedIsbn || !hasProductStructure) {
    throw new Error("Libraccio returned an unexpected product page.");
  }

  const metadata = getLibraccioMetadata(html, isbn13);
  const hasUsedBuyLink = html.includes("bBuyULink");
  const hasUsedBuyClass = html.includes("acquista-usato");
  const usedAvailability = html.match(/'availabilityUsed':'(SI|NO)'/)?.[1];

  // Any positive used-book identifier is sufficient.
  if (hasUsedBuyLink || hasUsedBuyClass || usedAvailability === "SI") {
    return {
      availability: "available",
      metadata,
    };
  }

  // Unavailability requires an explicit negative value.
  if (usedAvailability === "NO") {
    return {
      availability: "unavailable",
      metadata,
    };
  }

  throw new Error(
    "Libraccio returned unexpected used-book availability information.",
  );
}
