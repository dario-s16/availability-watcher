/**
 * Sends and receives messages through the Telegram Bot API.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 * Updated: 2026-07-26
 */

/**
 * Describes optional presentation settings for a Telegram message.
 */
interface TelegramMessageOptions {
  parseMode?: "HTML";
  disableLinkPreview?: boolean;
  keyboard?: string[][];
  persistentKeyboard?: boolean;
  oneTimeKeyboard?: boolean;
  removeKeyboard?: boolean;
}

/**
 * Describes the Telegram update fields used by this application.
 */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: {
      id: number;
      type: "private" | "group" | "supergroup" | "channel";
    };
    text?: string;
  };
}

/**
 * Describes a response returned by the Telegram getUpdates method.
 */
interface TelegramUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
  description?: string;
}

const telegramLongPollingSeconds = 30;
const telegramReceiveTimeoutMilliseconds = 40 * 1000;
const telegramSendTimeoutMilliseconds = 15 * 1000;

/**
 * Requests new messages from Telegram using long polling.
 */
export async function getTelegramUpdates(
  offset: number,
): Promise<TelegramUpdate[]> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (token === undefined) {
    throw new Error("Telegram bot token is missing.");
  }

  const url = new URL(`https://api.telegram.org/bot${token}/getUpdates`);

  // Requests only updates that have not already been handled.
  url.searchParams.set("offset", String(offset));

  // Allows Telegram to keep the request open while waiting for a message.
  url.searchParams.set("timeout", String(telegramLongPollingSeconds));

  // This application currently handles only normal messages.
  url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

  const response = await fetch(url, {
    signal: AbortSignal.timeout(telegramReceiveTimeoutMilliseconds),
  });

  if (!response.ok) {
    throw new Error(`Telegram returned HTTP status ${response.status}.`);
  }

  const data = (await response.json()) as TelegramUpdatesResponse;

  if (!data.ok) {
    throw new Error(data.description ?? "Telegram returned an API error.");
  }

  return data.result;
}

/**
 * Sends a message to one Telegram chat.
 */
export async function sendTelegramMessage(
  telegramChatId: number,
  message: string,
  options: TelegramMessageOptions = {},
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (token === undefined) {
    throw new Error("Telegram bot token is missing.");
  }

  const linkPreviewOptions =
    options.disableLinkPreview === true ? { is_disabled: true } : undefined;

  let replyMarkup: object | undefined;

  if (options.keyboard !== undefined) {
    // Converts every button label into the structure required by Telegram.
    const keyboard = options.keyboard.map((row) =>
      row.map((buttonText) => ({
        text: buttonText,
      })),
    );

    replyMarkup = {
      keyboard,
      resize_keyboard: true,
      is_persistent: options.persistentKeyboard,
      one_time_keyboard: options.oneTimeKeyboard,
    };
  } else if (options.removeKeyboard === true) {
    replyMarkup = {
      remove_keyboard: true,
    };
  }

  // Sends the target Chat ID, text, and optional settings to Telegram.
  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      signal: AbortSignal.timeout(telegramSendTimeoutMilliseconds),
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: message,
        parse_mode: options.parseMode,
        link_preview_options: linkPreviewOptions,
        reply_markup: replyMarkup,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Telegram returned HTTP status ${response.status}.`);
  }
}
