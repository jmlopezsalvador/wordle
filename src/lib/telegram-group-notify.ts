import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { sendTelegramMessage } from "@/lib/telegram";

function clipText(text: string, max = 180) {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export async function notifyTelegramGroupMembers(input: {
  groupId: string;
  actorUserId: string;
  text: string;
}) {
  try {
    const admin = createSupabaseAdminClient();

    const { data: members } = await admin
      .from("group_members")
      .select("user_id")
      .eq("group_id", input.groupId)
      .neq("user_id", input.actorUserId);

    const targetUserIds = (members || []).map((m) => m.user_id).filter(Boolean);
    if (targetUserIds.length === 0) return;

    const { data: links } = await admin
      .from("telegram_user_links")
      .select("telegram_user_id,app_user_id")
      .in("app_user_id", targetUserIds);

    const recipients = (links || []).map((l) => l.telegram_user_id).filter(Boolean);
    if (recipients.length === 0) return;

    const safeText = clipText(input.text, 3800);
    await Promise.allSettled(recipients.map((chatId) => sendTelegramMessage(chatId, safeText)));
  } catch {
    // Non-blocking notification path: never break main user flow.
  }
}

