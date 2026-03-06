import { NextResponse } from "next/server";
import { getActiveDayISO, getLastClosedDayISO } from "@/lib/active-day";
import { parseShareText } from "@/lib/parseShareText";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getTelegramWebhookSecret, parseTelegramCommand, sendTelegramMessage } from "@/lib/telegram";

type TelegramMessage = {
  message_id: number;
  text?: string;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; first_name?: string };
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

function helpText() {
  return [
    "Comandos del bot:",
    "/start",
    "/link <token>",
    "/join <codigo>",
    "/groups",
    "/ranking [codigo]",
    "/today [codigo]",
    "/submit <codigo> <share_text>",
    "/remind on <codigo> [HH:MM]",
    "/remind off <codigo>",
    "",
    "Tambien puedes enviar solo el share text si estas en un unico grupo."
  ].join("\n");
}

async function getLinkedAppUserId(admin: ReturnType<typeof createSupabaseAdminClient>, telegramUserId: number) {
  const { data } = await admin
    .from("telegram_user_links")
    .select("app_user_id")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  return data?.app_user_id as string | undefined;
}

async function resolveGroupByCode(admin: ReturnType<typeof createSupabaseAdminClient>, codeRaw: string) {
  const code = codeRaw.trim().toUpperCase();
  if (!code) return null;
  const { data } = await admin
    .from("groups")
    .select("id,name,code,new_member_start_points")
    .eq("code", code)
    .maybeSingle();
  return data;
}

async function ensureMembership(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  groupId: string,
  userId: string,
  initialPoints: number
) {
  await admin
    .from("group_members")
    .upsert({ group_id: groupId, user_id: userId, role: "member", initial_points: Math.max(0, initialPoints) }, { onConflict: "group_id,user_id" });

  await admin.from("member_scores").upsert(
    {
      group_id: groupId,
      user_id: userId,
      total_points: Math.max(0, initialPoints),
      calculated_through: getLastClosedDayISO(),
      updated_at: new Date().toISOString()
    },
    { onConflict: "group_id,user_id" }
  );
}

async function upsertSubmissionFromShare(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  userId: string,
  groupId: string,
  shareText: string
) {
  const parsed = parseShareText(shareText);
  const { data: gameType } = await admin
    .from("game_types")
    .select("id")
    .eq("key", parsed.gameKey === "unknown" ? "wordle" : parsed.gameKey)
    .eq("active", true)
    .maybeSingle();

  if (!gameType) {
    throw new Error("Tipo de juego no configurado o inactivo");
  }

  const playedOn = getActiveDayISO();

  await admin.from("submissions").upsert(
    {
      group_id: groupId,
      user_id: userId,
      game_type_id: gameType.id,
      game_edition: parsed.edition,
      played_on: playedOn,
      attempts: parsed.attempts,
      is_failure: parsed.isFailure,
      raw_share_text: shareText,
      grid_rows: parsed.gridRows
    },
    { onConflict: "group_id,user_id,game_type_id,played_on" }
  );

  await admin.rpc("recalc_member_score", {
    p_group_id: groupId,
    p_user_id: userId,
    p_through: playedOn
  });

  return { playedOn, attempts: parsed.attempts, gameKey: parsed.gameKey };
}

async function handleLinkCommand(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  msg: TelegramMessage,
  args: string[]
) {
  const token = (args[0] || "").trim();
  if (!token || !msg.from) {
    await sendTelegramMessage(msg.chat.id, "Uso: /link <token>");
    return;
  }

  const { data: linkToken } = await admin
    .from("telegram_link_tokens")
    .select("token,app_user_id,expires_at,used_at")
    .eq("token", token)
    .maybeSingle();

  if (!linkToken) {
    await sendTelegramMessage(msg.chat.id, "Token invalido.");
    return;
  }

  if (linkToken.used_at) {
    await sendTelegramMessage(msg.chat.id, "Token ya usado.");
    return;
  }

  if (new Date(linkToken.expires_at).getTime() < Date.now()) {
    await sendTelegramMessage(msg.chat.id, "Token expirado. Genera uno nuevo en la app.");
    return;
  }

  await admin.from("telegram_user_links").upsert(
    {
      telegram_user_id: msg.from.id,
      app_user_id: linkToken.app_user_id,
      telegram_username: msg.from.username ?? null,
      first_name: msg.from.first_name ?? null,
      updated_at: new Date().toISOString()
    },
    { onConflict: "telegram_user_id" }
  );

  await admin.from("telegram_link_tokens").update({ used_at: new Date().toISOString() }).eq("token", token).is("used_at", null);

  await sendTelegramMessage(msg.chat.id, "Cuenta enlazada correctamente. Ya puedes usar /join y /ranking.");
}

async function handleJoinCommand(admin: ReturnType<typeof createSupabaseAdminClient>, msg: TelegramMessage, args: string[]) {
  if (!msg.from) return;

  const appUserId = await getLinkedAppUserId(admin, msg.from.id);
  if (!appUserId) {
    await sendTelegramMessage(msg.chat.id, "Primero vincula tu cuenta: /link <token>");
    return;
  }

  const code = (args[0] || "").trim().toUpperCase();
  if (!code) {
    await sendTelegramMessage(msg.chat.id, "Uso: /join <codigo>");
    return;
  }

  const group = await resolveGroupByCode(admin, code);
  if (!group) {
    await sendTelegramMessage(msg.chat.id, `No existe el grupo con codigo ${code}.`);
    return;
  }

  await ensureMembership(admin, group.id, appUserId, group.new_member_start_points || 0);
  await sendTelegramMessage(msg.chat.id, `Te has unido a ${group.name} (${group.code}).`);
}

async function listUserGroups(admin: ReturnType<typeof createSupabaseAdminClient>, appUserId: string) {
  const { data } = await admin
    .from("group_members")
    .select("group_id,groups(id,name,code)")
    .eq("user_id", appUserId);

  return (data || [])
    .map((row) => (Array.isArray(row.groups) ? row.groups[0] : row.groups))
    .filter(Boolean) as Array<{ id: string; name: string; code: string }>;
}

async function resolveGroupForRead(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  appUserId: string,
  maybeCode: string | undefined
) {
  if (maybeCode) {
    const group = await resolveGroupByCode(admin, maybeCode);
    if (!group) return null;

    const { data: membership } = await admin
      .from("group_members")
      .select("group_id")
      .eq("group_id", group.id)
      .eq("user_id", appUserId)
      .maybeSingle();

    if (!membership) return null;
    return { id: group.id, name: group.name, code: group.code };
  }

  const groups = await listUserGroups(admin, appUserId);
  return groups[0] || null;
}

async function handleGroupsCommand(admin: ReturnType<typeof createSupabaseAdminClient>, msg: TelegramMessage) {
  if (!msg.from) return;
  const appUserId = await getLinkedAppUserId(admin, msg.from.id);
  if (!appUserId) {
    await sendTelegramMessage(msg.chat.id, "Primero vincula tu cuenta: /link <token>");
    return;
  }

  const groups = await listUserGroups(admin, appUserId);
  if (groups.length === 0) {
    await sendTelegramMessage(msg.chat.id, "No perteneces a ningun grupo. Usa /join <codigo>.");
    return;
  }

  await sendTelegramMessage(
    msg.chat.id,
    ["Tus grupos:", ...groups.map((g) => `- ${g.name} (${g.code})`)].join("\n")
  );
}

async function handleRankingCommand(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  msg: TelegramMessage,
  args: string[]
) {
  if (!msg.from) return;
  const appUserId = await getLinkedAppUserId(admin, msg.from.id);
  if (!appUserId) {
    await sendTelegramMessage(msg.chat.id, "Primero vincula tu cuenta: /link <token>");
    return;
  }

  const group = await resolveGroupForRead(admin, appUserId, args[0]);
  if (!group) {
    await sendTelegramMessage(msg.chat.id, "No encuentro ese grupo para tu cuenta.");
    return;
  }

  await admin.rpc("recalc_group_if_needed", { p_group_id: group.id });

  const [{ data: members }, { data: profiles }, { data: scores }] = await Promise.all([
    admin.from("group_members").select("user_id").eq("group_id", group.id),
    admin.from("profiles").select("id,username"),
    admin.from("member_scores").select("user_id,total_points").eq("group_id", group.id)
  ]);

  const nameById = new Map((profiles || []).map((p) => [p.id, p.username || "Usuario"]));
  const scoreById = new Map((scores || []).map((s) => [s.user_id, s.total_points || 0]));
  const ranking = (members || [])
    .map((m) => ({ userId: m.user_id, name: nameById.get(m.user_id) || "Usuario", score: scoreById.get(m.user_id) || 0 }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 10);

  await sendTelegramMessage(
    msg.chat.id,
    [`Ranking ${group.name}:`, ...ranking.map((r, i) => `${i + 1}. ${r.name} - ${r.score} pts`)].join("\n")
  );
}

async function handleTodayCommand(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  msg: TelegramMessage,
  args: string[]
) {
  if (!msg.from) return;
  const appUserId = await getLinkedAppUserId(admin, msg.from.id);
  if (!appUserId) {
    await sendTelegramMessage(msg.chat.id, "Primero vincula tu cuenta: /link <token>");
    return;
  }

  const group = await resolveGroupForRead(admin, appUserId, args[0]);
  if (!group) {
    await sendTelegramMessage(msg.chat.id, "No encuentro ese grupo para tu cuenta.");
    return;
  }

  const activeDay = getActiveDayISO();
  const [{ data: rows }, { data: gameTypes }] = await Promise.all([
    admin
      .from("submissions")
      .select("user_id,attempts,game_type_id")
      .eq("group_id", group.id)
      .eq("played_on", activeDay),
    admin.from("game_types").select("id").eq("active", true)
  ]);

  const { data: profiles } = await admin.from("profiles").select("id,username");
  const nameById = new Map((profiles || []).map((p) => [p.id, p.username || "Usuario"]));

  const byUser = new Map<string, { score: number; games: number }>();
  for (const row of rows || []) {
    const current = byUser.get(row.user_id) || { score: 0, games: 0 };
    byUser.set(row.user_id, { score: current.score + (row.attempts || 0), games: current.games + 1 });
  }

  const requiredGames = Math.max(1, (gameTypes || []).length);
  const list = [...byUser.entries()]
    .map(([userId, info]) => ({ userId, name: nameById.get(userId) || "Usuario", ...info }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 10);

  if (list.length === 0) {
    await sendTelegramMessage(msg.chat.id, `No hay resultados para ${activeDay} en ${group.name}.`);
    return;
  }

  await sendTelegramMessage(
    msg.chat.id,
    [
      `Resultados de ${group.name} (${activeDay}):`,
      ...list.map((r, i) => `${i + 1}. ${r.name} - ${r.score} pts (${r.games}/${requiredGames} juegos)`)
    ].join("\n")
  );
}

function parseSubmitCommandPayload(text: string) {
  const match = text.match(/^\/submit(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/i);
  if (!match) return null;
  return { code: match[1].trim().toUpperCase(), shareText: match[2].trim() };
}

async function handleSubmitCommand(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  msg: TelegramMessage,
  text: string
) {
  if (!msg.from) return;
  const appUserId = await getLinkedAppUserId(admin, msg.from.id);
  if (!appUserId) {
    await sendTelegramMessage(msg.chat.id, "Primero vincula tu cuenta: /link <token>");
    return;
  }

  const payload = parseSubmitCommandPayload(text);
  if (!payload) {
    await sendTelegramMessage(msg.chat.id, "Uso: /submit <codigo> <share_text>");
    return;
  }

  const group = await resolveGroupByCode(admin, payload.code);
  if (!group) {
    await sendTelegramMessage(msg.chat.id, `No existe el grupo con codigo ${payload.code}.`);
    return;
  }

  const { data: membership } = await admin
    .from("group_members")
    .select("group_id")
    .eq("group_id", group.id)
    .eq("user_id", appUserId)
    .maybeSingle();

  if (!membership) {
    await sendTelegramMessage(msg.chat.id, "No perteneces a ese grupo. Usa /join <codigo>.");
    return;
  }

  try {
    const saved = await upsertSubmissionFromShare(admin, appUserId, group.id, payload.shareText);
    await sendTelegramMessage(msg.chat.id, `Resultado guardado en ${group.name} (${saved.playedOn}). Intentos: ${saved.attempts}.`);
  } catch (err) {
    await sendTelegramMessage(msg.chat.id, `No pude guardar el resultado: ${(err as Error).message}`);
  }
}

async function handleImplicitShareText(admin: ReturnType<typeof createSupabaseAdminClient>, msg: TelegramMessage, text: string) {
  if (!msg.from) return;

  const appUserId = await getLinkedAppUserId(admin, msg.from.id);
  if (!appUserId) return;

  try {
    parseShareText(text);
  } catch {
    return;
  }

  const groups = await listUserGroups(admin, appUserId);
  if (groups.length !== 1) {
    await sendTelegramMessage(
      msg.chat.id,
      "Detecte un share text, pero perteneces a varios grupos. Usa /submit <codigo> <share_text>."
    );
    return;
  }

  try {
    const saved = await upsertSubmissionFromShare(admin, appUserId, groups[0].id, text);
    await sendTelegramMessage(msg.chat.id, `Resultado guardado en ${groups[0].name} (${saved.playedOn}). Intentos: ${saved.attempts}.`);
  } catch (err) {
    await sendTelegramMessage(msg.chat.id, `No pude guardar el resultado: ${(err as Error).message}`);
  }
}

function parseReminderArgs(args: string[]) {
  const mode = (args[0] || "").toLowerCase();
  const code = (args[1] || "").trim().toUpperCase();
  const time = (args[2] || "21:00").trim();

  if (!mode || !code) return null;

  const parts = time.split(":");
  if (parts.length !== 2) return null;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { mode, code, hour, minute };
}

async function handleRemindCommand(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  msg: TelegramMessage,
  args: string[]
) {
  if (!msg.from) return;

  const appUserId = await getLinkedAppUserId(admin, msg.from.id);
  if (!appUserId) {
    await sendTelegramMessage(msg.chat.id, "Primero vincula tu cuenta: /link <token>");
    return;
  }

  const parsed = parseReminderArgs(args);
  if (!parsed) {
    await sendTelegramMessage(msg.chat.id, "Uso: /remind on <codigo> [HH:MM] o /remind off <codigo>");
    return;
  }

  const group = await resolveGroupByCode(admin, parsed.code);
  if (!group) {
    await sendTelegramMessage(msg.chat.id, `No existe el grupo con codigo ${parsed.code}.`);
    return;
  }

  const { data: membership } = await admin
    .from("group_members")
    .select("group_id")
    .eq("group_id", group.id)
    .eq("user_id", appUserId)
    .maybeSingle();

  if (!membership) {
    await sendTelegramMessage(msg.chat.id, "No perteneces a ese grupo.");
    return;
  }

  if (parsed.mode === "off") {
    await admin
      .from("telegram_group_reminders")
      .upsert(
        {
          telegram_user_id: msg.from.id,
          group_id: group.id,
          enabled: false,
          updated_at: new Date().toISOString()
        },
        { onConflict: "telegram_user_id,group_id" }
      );
    await sendTelegramMessage(msg.chat.id, `Recordatorio desactivado para ${group.name}.`);
    return;
  }

  if (parsed.mode !== "on") {
    await sendTelegramMessage(msg.chat.id, "Uso: /remind on <codigo> [HH:MM] o /remind off <codigo>");
    return;
  }

  await admin
    .from("telegram_group_reminders")
    .upsert(
      {
        telegram_user_id: msg.from.id,
        group_id: group.id,
        enabled: true,
        hour_local: parsed.hour,
        minute_local: parsed.minute,
        updated_at: new Date().toISOString()
      },
      { onConflict: "telegram_user_id,group_id" }
    );

  await sendTelegramMessage(msg.chat.id, `Recordatorio activado para ${group.name} a las ${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")} (Madrid).`);
}

export async function POST(req: Request) {
  const secret = getTelegramWebhookSecret();
  if (secret) {
    const header = req.headers.get("x-telegram-bot-api-secret-token") || "";
    if (header !== secret) {
      return NextResponse.json({ ok: false }, { status: 401 });
    }
  }

  const update = (await req.json()) as TelegramUpdate;
  const msg = update.message;
  if (!msg || !msg.text || !msg.from) {
    return NextResponse.json({ ok: true });
  }

  const admin = createSupabaseAdminClient();
  const text = msg.text.trim();
  const { cmd, args } = parseTelegramCommand(text);

  try {
    if (cmd === "/start") {
      await sendTelegramMessage(msg.chat.id, `Bot listo.\n\n${helpText()}`);
    } else if (cmd === "/help") {
      await sendTelegramMessage(msg.chat.id, helpText());
    } else if (cmd === "/link") {
      await handleLinkCommand(admin, msg, args);
    } else if (cmd === "/join") {
      await handleJoinCommand(admin, msg, args);
    } else if (cmd === "/groups") {
      await handleGroupsCommand(admin, msg);
    } else if (cmd === "/ranking") {
      await handleRankingCommand(admin, msg, args);
    } else if (cmd === "/today") {
      await handleTodayCommand(admin, msg, args);
    } else if (cmd === "/submit") {
      await handleSubmitCommand(admin, msg, text);
    } else if (cmd === "/remind") {
      await handleRemindCommand(admin, msg, args);
    } else {
      await handleImplicitShareText(admin, msg, text);
    }
  } catch (err) {
    await sendTelegramMessage(msg.chat.id, `Error interno: ${(err as Error).message}`);
  }

  return NextResponse.json({ ok: true, activeDay: getActiveDayISO(), closedDay: getLastClosedDayISO() });
}
