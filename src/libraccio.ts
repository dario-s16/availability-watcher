/**
 * Retrieves used-book availability and book information from Libraccio.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 */

import type { BookMetadata } from "./book-metadata.js";
import { validateAndConvertToIsbn13 } from "./isbn.js";

const libraccioBookUrl = "https://www.libraccio.it/libro";
const libraccioRequestTimeoutMilliseconds = 15000;

const libraccioSearchUrl = "https://www.libraccio.it/src/";
const maximumLibraccioSearchResults = 4;

export type LibraccioAvailability = "available" | "unavailable" | "not-found";

export interface LibraccioBookData {
  availability: LibraccioAvailability;
  metadata: BookMetadata | undefined;
  newPriceInCents: number | undefined;
  usedPriceInCents: number | undefined;
}

export interface LibraccioBookSearchResult {
  isbn13: string;
  title: string;
  authors: string | undefined;
  editionYear: number | undefined;
  publisher: string | undefined;
}

/**
 * Converts a Libraccio price into integer euro cents.
 */
function getPriceInCents(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const match = value.trim().match(/^(\d+)(?:[.,](\d{1,2}))?$/);

  if (match === null) {
    return undefined;
  }

  const euros = match[1];

  if (euros === undefined) {
    return undefined;
  }

  const cents = (match[2] ?? "").padEnd(2, "0");

  return Number(euros) * 100 + Number(cents);
}

/**
 * Extracts and validates an ISBN from a Libraccio book URL.
 */
export function getIsbnFromLibraccioUrl(value: string): string | undefined {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  const hasSupportedProtocol =
    url.protocol === "https:" || url.protocol === "http:";

  const hasLibraccioHost =
    url.hostname === "libraccio.it" || url.hostname === "www.libraccio.it";

  if (!hasSupportedProtocol || !hasLibraccioHost) {
    return undefined;
  }

  const pathSegments = url.pathname
    .split("/")
    .filter((segment) => segment !== "");

  const bookSegmentIndex = pathSegments.indexOf("libro");

  if (bookSegmentIndex === -1) {
    return undefined;
  }

  for (const segment of pathSegments.slice(bookSegmentIndex + 1)) {
    const isbn13 = validateAndConvertToIsbn13(segment);

    if (isbn13 !== undefined) {
      return isbn13;
    }
  }

  return undefined;
}

/**
 * Converts the HTML entities used inside Libraccio tracking data.
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (entity, decimalCode: string) => {
      const codePoint = Number(decimalCode);

      return Number.isInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    })
    .replace(/&#x([0-9a-f]+);/gi, (entity, hexadecimalCode: string) => {
      const codePoint = Number.parseInt(hexadecimalCode, 16);

      return Number.isInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Extracts one named value from a Libraccio product-tracking block.
 */
function getTrackingValue(
  productBlock: string,
  fieldName: string,
): string | undefined {
  const match = productBlock.match(
    new RegExp(`['"]${fieldName}['"]\\s*:\\s*'((?:\\\\.|[^'])*)'`),
  );

  return match?.[1]?.replace(/\\'/g, "'").replace(/\\\\/g, "\\").trim();
}

/**
 * Normalizes titles so punctuation, accents, and capitalization do not affect
 * exact-title comparison.
 */
function normalizeBookTitle(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("it-IT")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Searches Libraccio by title and returns at most four validated editions.
 */
export async function searchLibraccioBooks(
  query: string,
): Promise<LibraccioBookSearchResult[]> {
  const url = new URL(libraccioSearchUrl);

  url.searchParams.set("FT", query);
  url.searchParams.set("CH", "libraccio");
  url.searchParams.set("DF", "1120");
  url.searchParams.set("PX", "1");
  url.searchParams.set("SRT", "-1");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(libraccioRequestTimeoutMilliseconds),
  });

  if (!response.ok) {
    throw new Error(`Libraccio returned HTTP status ${response.status}.`);
  }

  const html = decodeHtmlEntities(await response.text());

  if (!html.includes("boxprodlist")) {
    throw new Error("Libraccio returned an unexpected search page.");
  }

  const results: LibraccioBookSearchResult[] = [];
  const foundIsbns = new Set<string>();
  const productBlocks = html.matchAll(
    /["']products["']\s*:\s*\[\{([\s\S]*?)\}\]/g,
  );

  for (const match of productBlocks) {
    const productBlock = match[1];

    if (productBlock === undefined) {
      continue;
    }

    const title = getTrackingValue(productBlock, "name");
    const productCode = getTrackingValue(productBlock, "id");

    if (title === undefined || productCode === undefined) {
      continue;
    }

    const isbn13 = validateAndConvertToIsbn13(productCode);

    if (isbn13 === undefined || foundIsbns.has(isbn13)) {
      continue;
    }

    const authors = getTrackingValue(productBlock, "author");
    const publisher = getTrackingValue(productBlock, "publisher");
    const editionYearText = getTrackingValue(productBlock, "yearEdition");

    const editionYear =
      editionYearText !== undefined && /^\d{4}$/.test(editionYearText)
        ? Number(editionYearText)
        : undefined;

    foundIsbns.add(isbn13);
    results.push({
      isbn13,
      title,
      authors: authors === "" ? undefined : authors,
      editionYear,
      publisher: publisher === "" ? undefined : publisher,
    });
  }

  const normalizedQuery = normalizeBookTitle(query);

  return results
    .sort((firstResult, secondResult) => {
      const firstIsExact =
        normalizeBookTitle(firstResult.title) === normalizedQuery;
      const secondIsExact =
        normalizeBookTitle(secondResult.title) === normalizedQuery;

      if (firstIsExact !== secondIsExact) {
        return firstIsExact ? -1 : 1;
      }

      if (firstIsExact && secondIsExact) {
        return (secondResult.editionYear ?? 0) - (firstResult.editionYear ?? 0);
      }

      return 0;
    })
    .slice(0, maximumLibraccioSearchResults);
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
      newPriceInCents: undefined,
      usedPriceInCents: undefined,
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

  const newPriceText =
    html.match(/'productdiscount_price':'([^']+)'/)?.[1] ??
    html.match(/'prezzonuovo':'([^']+)'/)?.[1];

  const usedPriceText =
    html.match(/'productused_price':'([^']+)'/)?.[1] ??
    html.match(/'prezzousato':'([^']+)'/)?.[1];

  const newPriceInCents = getPriceInCents(newPriceText);
  const usedPriceInCents = getPriceInCents(usedPriceText);

  const metadata = getLibraccioMetadata(html, isbn13);
  const hasUsedBuyLink = html.includes("bBuyULink");
  const hasUsedBuyClass = html.includes("acquista-usato");
  const usedAvailability = html.match(/'availabilityUsed':'(SI|NO)'/)?.[1];

  // Any positive used-book identifier is sufficient.
  if (hasUsedBuyLink || hasUsedBuyClass || usedAvailability === "SI") {
    return {
      availability: "available",
      metadata,
      newPriceInCents,
      usedPriceInCents,
    };
  }

  // Unavailability requires an explicit negative value.
  if (usedAvailability === "NO") {
    return {
      availability: "unavailable",
      metadata,
      newPriceInCents,
      usedPriceInCents: undefined,
    };
  }

  throw new Error(
    "Libraccio returned unexpected used-book availability information.",
  );
}
