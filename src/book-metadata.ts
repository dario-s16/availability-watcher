/**
 * Retrieves book information from external metadata services.
 *
 * Author: Dario Santoni
 * Created: 2026-07-25
 */

import { setTimeout } from "node:timers/promises";

const googleRetryDelayMilliseconds = 1000;
const metadataRequestTimeoutMilliseconds = 8000;

export interface BookMetadata {
  title: string;
  authors: string | undefined;
  editionYear: number | undefined;
  publisher: string | undefined;
  source:
    | "google-books"
    | "open-library"
    | "libraccio"
    | "google-books+open-library"
    | "google-books+libraccio"
    | "open-library+libraccio"
    | "google-books+open-library+libraccio";
}

interface GoogleVolumeInfo {
  title?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  industryIdentifiers?: Array<{
    type?: string;
    identifier?: string;
  }>;
}

interface GoogleBooksResponse {
  items?: Array<{
    volumeInfo?: GoogleVolumeInfo;
  }>;
}

interface OpenLibraryEdition {
  title?: string;
  publishers?: string[];
  isbn_13?: string[];
  authors?: Array<{
    key?: string;
  }>;
}

interface OpenLibraryAuthor {
  name?: string;
}

/**
 * Searches Google Books and accepts only a result containing the requested ISBN.
 */
async function getGoogleBooksMetadata(
  isbn13: string,
): Promise<BookMetadata | undefined> {
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;

  // Google Books is optional when no API key has been configured.
  if (apiKey === undefined) {
    return undefined;
  }

  const url = new URL("https://www.googleapis.com/books/v1/volumes");
  url.searchParams.set("q", `isbn:${isbn13}`);
  url.searchParams.set("key", apiKey);
  url.searchParams.set("maxResults", "5");

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetch(url, {
      // Prevents the metadata lookup from waiting indefinitely.
      signal: AbortSignal.timeout(metadataRequestTimeoutMilliseconds),
    });

    // A Google backend failure is retried once after a short pause.
    if (response.status === 503 && attempt === 1) {
      await setTimeout(googleRetryDelayMilliseconds);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Google Books returned HTTP status ${response.status}.`);
    }

    const data = (await response.json()) as GoogleBooksResponse;

    // Google can return related books, so the ISBN must match exactly.
    const book = data.items
      ?.map((item) => item.volumeInfo)
      .find((volumeInfo) =>
        volumeInfo?.industryIdentifiers?.some(
          (identifier) =>
            identifier.type === "ISBN_13" && identifier.identifier === isbn13,
        ),
      );

    if (book?.title === undefined) {
      return undefined;
    }

    const editionYearText = book.publishedDate?.match(/^\d{4}/)?.[0];

    return {
      title: book.title,
      authors: book.authors?.join(", "),
      editionYear:
        editionYearText === undefined ? undefined : Number(editionYearText),
      publisher: book.publisher,
      source: "google-books",
    };
  }

  return undefined;
}

/**
 * Retrieves author names from their Open Library identifiers.
 */
async function getOpenLibraryAuthorNames(
  authorReferences: Array<{ key?: string }> | undefined,
): Promise<string | undefined> {
  const authorNames: string[] = [];

  for (const authorReference of authorReferences ?? []) {
    if (authorReference.key === undefined) {
      continue;
    }

    const url = new URL(
      `${authorReference.key}.json`,
      "https://openlibrary.org",
    );

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(metadataRequestTimeoutMilliseconds),
      });

      if (!response.ok) {
        console.error(
          `Open Library author lookup failed: HTTP status ${response.status}.`,
        );
        continue;
      }

      const author = (await response.json()) as OpenLibraryAuthor;

      if (author.name !== undefined) {
        authorNames.push(author.name);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error.";

      console.error(`Open Library author lookup failed: ${reason}`);
    }
  }

  return authorNames.length === 0 ? undefined : authorNames.join(", ");
}

/**
 * Retrieves information for the exact ISBN edition from Open Library.
 */
async function getOpenLibraryMetadata(
  isbn13: string,
): Promise<BookMetadata | undefined> {
  const url = new URL(`https://openlibrary.org/isbn/${isbn13}.json`);

  const response = await fetch(url, {
    // Open Library may occasionally respond slowly.
    signal: AbortSignal.timeout(metadataRequestTimeoutMilliseconds),
  });

  // A missing edition is a normal result, not an application error.
  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(`Open Library returned HTTP status ${response.status}.`);
  }

  const edition = (await response.json()) as OpenLibraryEdition;

  // Confirms that the returned edition contains the requested ISBN.
  if (edition.title === undefined || !edition.isbn_13?.includes(isbn13)) {
    return undefined;
  }

  const authors = await getOpenLibraryAuthorNames(edition.authors);

  return {
    title: edition.title,
    authors,

    // Open Library dates are not used because they may be inaccurate.
    editionYear: undefined,
    publisher: edition.publishers?.[0],
    source: "open-library",
  };
}

/**
 * Uses Libraccio only to complete fields still missing from the API result.
 */
function addLibraccioFallback(
  apiMetadata: BookMetadata | undefined,
  libraccioMetadata: BookMetadata | undefined,
): BookMetadata | undefined {
  if (apiMetadata === undefined) {
    return libraccioMetadata;
  }

  if (libraccioMetadata === undefined) {
    return apiMetadata;
  }

  const authors = apiMetadata.authors ?? libraccioMetadata.authors;
  const editionYear = apiMetadata.editionYear ?? libraccioMetadata.editionYear;
  const publisher = apiMetadata.publisher ?? libraccioMetadata.publisher;

  const libraccioWasUsed =
    authors !== apiMetadata.authors ||
    editionYear !== apiMetadata.editionYear ||
    publisher !== apiMetadata.publisher;

  // Keeps the original source when Libraccio did not add any information.
  if (!libraccioWasUsed) {
    return apiMetadata;
  }

  let source: BookMetadata["source"] = apiMetadata.source;

  if (apiMetadata.source === "google-books") {
    source = "google-books+libraccio";
  } else if (apiMetadata.source === "open-library") {
    source = "open-library+libraccio";
  } else if (apiMetadata.source === "google-books+open-library") {
    source = "google-books+open-library+libraccio";
  }

  return {
    title: apiMetadata.title,
    authors,
    editionYear,
    publisher,
    source,
  };
}

/**
 * Uses Google Books first, Open Library second, and Libraccio last.
 */
export async function getBookMetadata(
  isbn13: string,
  libraccioMetadata?: BookMetadata,
): Promise<BookMetadata | undefined> {
  let googleMetadata: BookMetadata | undefined;

  try {
    googleMetadata = await getGoogleBooksMetadata(isbn13);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown error.";

    console.error(`Google Books metadata lookup failed: ${reason}`);
  }

  // Open Library is unnecessary when Google already has these fields.
  if (
    googleMetadata?.authors !== undefined &&
    googleMetadata.publisher !== undefined
  ) {
    return addLibraccioFallback(googleMetadata, libraccioMetadata);
  }

  let openLibraryMetadata: BookMetadata | undefined;

  try {
    openLibraryMetadata = await getOpenLibraryMetadata(isbn13);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown error.";

    console.error(`Open Library metadata lookup failed: ${reason}`);

    return addLibraccioFallback(googleMetadata, libraccioMetadata);
  }

  if (googleMetadata === undefined) {
    return addLibraccioFallback(openLibraryMetadata, libraccioMetadata);
  }

  if (openLibraryMetadata === undefined) {
    return addLibraccioFallback(googleMetadata, libraccioMetadata);
  }

  const authors = googleMetadata.authors ?? openLibraryMetadata.authors;
  const publisher = googleMetadata.publisher ?? openLibraryMetadata.publisher;

  // Open Library did not add information missing from Google.
  if (
    authors === googleMetadata.authors &&
    publisher === googleMetadata.publisher
  ) {
    return addLibraccioFallback(googleMetadata, libraccioMetadata);
  }

  const apiMetadata: BookMetadata = {
    title: googleMetadata.title,
    authors,
    editionYear: googleMetadata.editionYear,
    publisher,
    source: "google-books+open-library",
  };

  return addLibraccioFallback(apiMetadata, libraccioMetadata);
}
