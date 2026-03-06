const TELEGRAM_API_BASE = "https://api.telegram.org";

type InlineButton = { text: string; callback_data: string };

function getBotToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  return token;
}

export function getTelegramWebhookSecret() {
  return process.env.TELEGRAM_WEBHOOK_SECRET || "";
}

export async function sendTelegramMessage(chatId: number | string, text: string) {
  const token = getBotToken();
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed: ${response.status} ${body}`);
  }
}

export async function sendTelegramInlineKeyboardMessage(
  chatId: number | string,
  text: string,
  keyboard: InlineButton[][]
) {
  const token = getBotToken();
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: keyboard
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram inline sendMessage failed: ${response.status} ${body}`);
  }
}

export async function answerTelegramCallbackQuery(callbackQueryId: string, text?: string) {
  const token = getBotToken();
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: false
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram answerCallbackQuery failed: ${response.status} ${body}`);
  }
}

export function parseTelegramCommand(text: string) {
  const raw = text.trim();
  if (!raw.startsWith("/")) return { cmd: "", args: [] as string[] };
  const [command, ...args] = raw.split(/\s+/);
  const cmd = command.split("@")[0].toLowerCase();
  return { cmd, args };
}
