import assert from "node:assert/strict";
import test from "node:test";

import { validateAndConvertToIsbn13 } from "../dist/isbn.js";
import { getIsbnFromLibraccioUrl } from "../dist/libraccio.js";

test("accepts a valid ISBN-13", () => {
  assert.equal(validateAndConvertToIsbn13("9788806222185"), "9788806222185");
});

test("converts a valid ISBN-10 to ISBN-13", () => {
  assert.equal(validateAndConvertToIsbn13("880622218X"), "9788806222185");
});

test("rejects an invalid ISBN", () => {
  assert.equal(validateAndConvertToIsbn13("9788806222184"), undefined);
});

test("extracts an ISBN from a Libraccio book URL", () => {
  assert.equal(
    getIsbnFromLibraccioUrl(
      "https://www.libraccio.it/libro/9788806222185/book.html",
    ),
    "9788806222185",
  );
});

test("rejects a URL from another website", () => {
  assert.equal(
    getIsbnFromLibraccioUrl(
      "https://example.com/libro/9788806222185/book.html",
    ),
    undefined,
  );
});
