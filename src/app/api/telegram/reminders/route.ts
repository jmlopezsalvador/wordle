import { NextResponse } from "next/server";
import { getActiveDayISO } from "@/lib/active-day";
import { buildTelegramReminderMessage } from "@/lib/telegram-reminder-messages";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { sendTelegramMessage } from "@/lib/telegram";

function getMadridTimeParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value || "0";
  return { hour: Number(get("hour")), minute: Number(get("minute")) };
}

const FIXED_REMINDER_HOURS = new Set([12, 20]);

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const expected = process.env.TELEGRAM_CRON_SECRET || process.env.CRON_SECRET || "";

  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const { hour, minute } = getMadridTimeParts(new Date());
  const activeDay = getActiveDayISO();
  const shouldRunNow = minute === 0 && FIXED_REMINDER_HOURS.has(hour);

  if (!shouldRunNow) {
    return NextResponse.json({ ok: true, skipped: true, hour, minute, activeDay });
  }

  const { data: reminders } = await admin
    .from("telegram_group_reminders")
    .select("telegram_user_id,group_id")
    .eq("enabled", true);

  let sent = 0;

  for (const reminder of reminders || []) {
    const [{ data: link }, { data: group }, { data: games }] = await Promise.all([
      admin
        .from("telegram_user_links")
        .select("app_user_id")
        .eq("telegram_user_id", reminder.telegram_user_id)
        .maybeSingle(),
      admin.from("groups").select("id,name,code").eq("id", reminder.group_id).maybeSingle(),
      admin.from("game_types").select("id").eq("active", true)
    ]);

    if (!link || !group) continue;

    const { data: submissions } = await admin
      .from("submissions")
      .select("game_type_id")
      .eq("group_id", reminder.group_id)
      .eq("user_id", link.app_user_id)
      .eq("played_on", activeDay);

    const required = Math.max(1, (games || []).length);
    const done = new Set((submissions || []).map((s) => s.game_type_id)).size;
    if (done >= required) continue;

    await sendTelegramMessage(
      reminder.telegram_user_id,
      buildTelegramReminderMessage({
        groupName: group.name,
        missing: required - done,
        activeDay,
        groupCode: group.code
      })
    );
    sent += 1;
  }

  return NextResponse.json({ ok: true, sent, hour, minute, activeDay });
}
