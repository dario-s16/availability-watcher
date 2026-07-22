/**
 * Sends and receives messages through the Telegram Bot API.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 * Updated: 2026-07-23
 */

/**
 * Describes the Telegram update fields used by this application.
 */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: {
      id: number;
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
  url.searchParams.set("timeout", "30");

  // This application currently handles only normal messages.
  url.searchParams.set("allowed_updates", JSON.stringify(["message"]));

  const response = await fetch(url);

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
 * Sends a text message to the Telegram chat configured in the environment.
 * The returned Promise completes without a value when the message is sent.
 */
export async function sendTelegramMessage(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  // Both values are required, but must remain outside the source code.
  if (token === undefined || chatId === undefined) {
    throw new Error("Telegram configuration is missing.");
  }

  // Sends the chat ID and message text to the Telegram Bot API.
  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Telegram returned HTTP status ${response.status}.`);
  }
}
