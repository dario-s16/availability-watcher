/**
 * Sends notifications through the Telegram Bot API.
 *
 * Author: Dario Santoni
 * Created: 2026-07-19
 */

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
