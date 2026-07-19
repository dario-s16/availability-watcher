/**
 * Validates ISBN values and converts them to ISBN-13.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 */

/**
 * Calculates the official ISBN-13 check digit.
 */
function calculateIsbn13CheckDigit(firstTwelveDigits: string): number {
  let sum = 0;

  for (let index = 0; index < 12; index += 1) {
    const digit = Number(firstTwelveDigits.charAt(index));
    const weight = index % 2 === 0 ? 1 : 3;

    sum += digit * weight;
  }

  return (10 - (sum % 10)) % 10;
}

/**
 * Checks whether a normalized ISBN-10 is valid.
 */
function isValidIsbn10(isbn: string): boolean {
  if (!/^\d{9}[\dX]$/.test(isbn)) {
    return false;
  }

  let sum = 0;

  for (let index = 0; index < 10; index += 1) {
    const character = isbn.charAt(index);
    const digit = character === "X" ? 10 : Number(character);
    const weight = 10 - index;

    sum += digit * weight;
  }

  return sum % 11 === 0;
}

/**
 * Validates ISBN-10 or ISBN-13 and returns a valid ISBN-13.
 * Returns undefined when the value is invalid.
 */
export function validateAndConvertToIsbn13(value: string): string | undefined {
  const isbn = value.replace(/[\s-]/g, "").toUpperCase();

  if (/^(978|979)\d{10}$/.test(isbn)) {
    const firstTwelveDigits = isbn.slice(0, 12);
    const expectedCheckDigit = calculateIsbn13CheckDigit(firstTwelveDigits);
    const actualCheckDigit = Number(isbn.charAt(12));

    return actualCheckDigit === expectedCheckDigit ? isbn : undefined;
  }

  if (!isValidIsbn10(isbn)) {
    return undefined;
  }

  const firstTwelveDigits = `978${isbn.slice(0, 9)}`;
  const checkDigit = calculateIsbn13CheckDigit(firstTwelveDigits);

  return `${firstTwelveDigits}${checkDigit}`;
}
