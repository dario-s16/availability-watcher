/**
 * Reads and validates the application configuration.
 */

/**
 * Reads a positive integer from an environment variable.
 * The default value is used when the variable is missing or empty.
 */
function readPositiveInteger(name: string, defaultValue: number): number {
  const value = process.env[name];

  if (value === undefined || value === "") {
    return defaultValue;
  }

  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return number;
}

/**
 * Reads an optional positive integer from an environment variable.
 */
function readOptionalPositiveInteger(name: string): number | undefined {
  const value = process.env[name];

  if (value === undefined || value === "") {
    return undefined;
  }

  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return number;
}

export const maximumActiveUsers = readPositiveInteger(
  "MAXIMUM_ACTIVE_USERS",
  50,
);

export const maximumWatchesPerUser = readPositiveInteger(
  "MAXIMUM_WATCHES_PER_USER",
  30,
);

export const maximumUniqueBooks = readPositiveInteger(
  "MAXIMUM_UNIQUE_BOOKS",
  250,
);

export const telegramAdminChatId = readOptionalPositiveInteger(
  "TELEGRAM_ADMIN_CHAT_ID",
);
