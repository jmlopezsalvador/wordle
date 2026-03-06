import { NextResponse } from "next/server";
import { getActiveDayISO, getLastClosedDayISO } from "@/lib/active-day";
import { parseShareText } from "@/lib/parseShareText";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  answerTelegramCallbackQuery,
  getTelegramWebhookSecret,
  parseTelegramCommand,
  sendTelegramInlineKeyboardMessage,
  sendTelegramMessage
} from "@/lib/telegram";

type TelegramFrom = {
  id: number;
  username?: string;
  first_name?: string;
};

type TelegramMessage = {
  message_id: number;
  text?: string;
  chat: { id: number; type: string };
  from?: TelegramFrom;
};

type TelegramCallbackQuery = {
  id: string;
  from: TelegramFrom;
  data?: string;
  message?: {
    chat: { id: number; type: string };
    message_id: number;
  };
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type UserGroup = { id: string; name: string; code: string };

type PendingActionType = "submit" | "comment";

function helpText() {
  return [
    "Comandos del bot:",
    "/start",
    "/link <token>",
    "/groups (seleccionar grupo activo)",
    "/ranking",
    "/today",
    "/submit <share_text>",
    "/comment <texto>",
    "/remind on [HH:MM]",
    "/remind off",
    "",
    "Nota: para unirte a grupos se usa la app web."
  ].join("\n");
}

function shortText(value: string, max = 120) {
  const t = value.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

async function getLinkedAppUserId(admin: ReturnType<typeof createSupabaseAdminClient>, telegramUserId: number) {
  const { data } = await admin
    .from("telegram_user_links")
    .select("app_user_id")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  return data?.app_user_id as string | undefined;
}

async function listUserGroups(admin: ReturnType<typeof createSupabaseAdminClient>, appUserId: string) {
  const { data } = await admin
    .from("group_members")
    .select("group_id,groups(id,name,code)")
    .eq("user_id", appUserId);

  return (data || [])
    .map((row) => (Array.isArray(row.groups) ? row.groups[0] : row.groups))
    .filter(Boolean) as UserGroup[];
}

async function upsertTelegramLinkProfile(admin: ReturnType<typeof createSupabaseAdminClient>, from: TelegramFrom, appUserId: string) {
  await admin.from("telegram_user_links").upsert(
    {
      telegram_user_id: from.id,
      app_user_id: appUserId,
      telegram_username: from.username ?? null,
      first_name: from.first_name ?? null,
      updated_at: new Date().toISOString()
    },
    { onConflict: "telegram_user_id" }
  );
}

async function setActiveGroup(admin: ReturnType<typeof createSupabaseAdminClient>, telegramUserId: number, groupId: string) {
  await admin.from("telegram_user_state").upsert(
    {
      telegram_user_id: telegramUserId,
      active_group_id: groupId,
      updated_at: new Date().toISOString()
    },
    { onConflict: "telegram_user_id" }
  );
}

async function getActiveGroup(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  telegramUserId: number,
  appUserId: string
): Promise<UserGroup | null> {
  const { data: state } = await admin
    .from("telegram_user_state")
    .select("active_group_id")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();

  const groups = await listUserGroups(admin, appUserId);
  if (groups.length === 0) return null;

  if (state?.active_group_id) {
    const selected = groups.find((g) => g.id === state.active_group_id);
    if (selected) return selected;
  }

  if (groups.length === 1) {
    await setActiveGroup(admin, telegramUserId, groups[0].id);
    return groups[0];
  }

  return null;
}

async function sendGroupSelectionMenu(chatId: number, groups: UserGroup[], title = "Selecciona grupo activo") {
  const keyboard = groups.map((g) => [{ text: `${g.name} (${g.code})`, callback_data: `set_group:${g.id}` }]);
  await sendTelegramInlineKeyboardMessage(chatId, title, keyboard);
}

async function requireLinkedUser(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  from: TelegramFrom,
  chatId: number
) {
  const appUserId = await getLinkedAppUserId(admin, from.id);
  if (!appUserId) {
    await sendTelegramMessage(chatId, "Primero vincula tu cuenta: /link <token>");
    return null;
  }
  await upsertTelegramLinkProfile(admin, from, appUserId);
  return appUserId;
}

async function requireActiveGroup(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  from: TelegramFrom,
  chatId: number,
  promptTitle?: string
) {
  const appUserId = await requireLinkedUser(admin, from, chatId);
  if (!appUserId) return null;

  const group = await getActiveGroup(admin, from.id, appUserId);
  if (group) return { appUserId, group };

  const groups = await listUserGroups(admin, appUserId);
  if (groups.length === 0) {
    await sendTelegramMessage(chatId, "No perteneces a ningun grupo. Unete desde la app web.");
    return null;
  }

  await sendGroupSelectionMenu(chatId, groups, promptTitle || "No tienes grupo activo. Selecciona uno:");
  return null;
}

async function createPendingAction(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  telegramUserId: number,
  appUserId: string,
  groupId: string,
  actionType: PendingActionType,
  payload: Record<string, unknown>
) {
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("telegram_pending_actions")
    .insert({
      telegram_user_id: telegramUserId,
      app_user_id: appUserId,
      group_id: groupId,
      action_type: actionType,
      payload,
      expires_at: expiresAt
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(`No se pudo crear accion pendiente: ${error?.message || "unknown"}`);
  return data.id as string;
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

  return { playedOn, attempts: parsed.attempts };
}

async function insertGroupComment(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  groupId: string,
  userId: string,
  body: string
) {
  const activeDay = getActiveDayISO();
  await admin.from("group_comments").insert({
    group_id: groupId,
    user_id: userId,
    comment_date: activeDay,
    body: body.trim(),
    parent_comment_id: null
  });
  return activeDay;
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

  await upsertTelegramLinkProfile(admin, msg.from, linkToken.app_user_id as string);
  await admin.from("telegram_link_tokens").update({ used_at: new Date().toISOString() }).eq("token", token).is("used_at", null);

  const groups = await listUserGroups(admin, linkToken.app_user_id as string);
  if (groups.length === 1) {
    await setActiveGroup(admin, msg.from.id, groups[0].id);
  }

  await sendTelegramMessage(msg.chat.id, "Cuenta enlazada correctamente. Usa /groups para elegir grupo activo.");
}

async function handleGroupsCommand(admin: ReturnType<typeof createSupabaseAdminClient>, msg: TelegramMessage) {
  if (!msg.from) return;
  const appUserId = await requireLinkedUser(admin, msg.from, msg.chat.id);
  if (!appUserId) return;

  const groups = await listUserGroups(admin, appUserId);
  if (groups.length === 0) {
    await sendTelegramMessage(msg.chat.id, "No perteneces a ningun grupo. Unete desde la app web.");
    return;
  }

  await sendGroupSelectionMenu(msg.chat.id, groups, "Tus grupos: selecciona el grupo activo");
}

async function handleRankingCommand(admin: ReturnType<typeof createSupabaseAdminClient>, msg: TelegramMessage) {
  if (!msg.from) return;
  const resolved = await requireActiveGroup(admin, msg.from, msg.chat.id, "Para /ranking, primero elige grupo activo:");
  if (!resolved) return;
  const { group } = resolved;

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

  await sendTelegramMessage(msg.chat.id, [`Ranking ${group.name}:`, ...ranking.map((r, i) => `${i + 1}. ${r.name} - ${r.score} pts`)].join("\n"));
}

async function handleTodayCommand(admin: ReturnType<typeof createSupabaseAdminClient>, msg: TelegramMessage) {
  if (!msg.from) return;
  const resolved = await requireActiveGroup(admin, msg.from, msg.chat.id, "Para /today, primero elige grupo activo:");
  if (!resolved) return;
  const { group } = resolved;

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

async function handleSubmitCommand(admin: ReturnType<typeof createSupabaseAdminClient>, msg: TelegramMessage, text: string) {
  if (!msg.from) return;
  const resolved = await requireActiveGroup(admin, msg.from, msg.chat.id, "Para /submit, primero elige grupo activo:");
  if (!resolved) return;
  const { appUserId, group } = resolved;

  const payload = text.replace(/^\/submit(?:@\w+)?\s*/i, "").trim();
  if (!payload) {
    await sendTelegramMessage(msg.chat.id, "Uso: /submit <share_text>");
    return;
  }

  try {
    parseShareText(payload);
  } catch {
    await sendTelegramMessage(msg.chat.id, "No pude parsear ese share text. Pegalo completo.");
    return;
  }

  const pendingId = await createPendingAction(admin, msg.from.id, appUserId, group.id, "submit", { shareText: payload });
  await sendTelegramInlineKeyboardMessage(
    msg.chat.id,
    `Vas a guardar resultado en ${group.name}. Confirmas?`,
    [
      [
        { text: "Confirmar", callback_data: `confirm:${pendingId}` },
        { text: "Cancelar", callback_data: `cancel:${pendingId}` }
      ]
    ]
  );
}

async function handleCommentCommand(admin: ReturnType<typeof createSupabaseAdminClient>, msg: TelegramMessage, text: string) {
  if (!msg.from) return;
  const resolved = await requireActiveGroup(admin, msg.from, msg.chat.id, "Para /comment, primero elige grupo activo:");
  if (!resolved) return;
  const { appUserId, group } = resolved;

  const comment = text.replace(/^\/comment(?:@\w+)?\s*/i, "").trim();
  if (!comment) {
    await sendTelegramMessage(msg.chat.id, "Uso: /comment <texto>");
    return;
  }

  if (comment.length > 280) {
    await sendTelegramMessage(msg.chat.id, "El comentario supera 280 caracteres.");
    return;
  }

  const pendingId = await createPendingAction(admin, msg.from.id, appUserId, group.id, "comment", { body: comment });
  await sendTelegramInlineKeyboardMessage(
    msg.chat.id,
    `Comentario para ${group.name}:\n"${shortText(comment, 140)}"\n\nConfirmas envio?`,
    [
      [
        { text: "Confirmar", callback_data: `confirm:${pendingId}` },
        { text: "Cancelar", callback_data: `cancel:${pendingId}` }
      ]
    ]
  );
}

function parseReminderArgs(args: string[]) {
  const mode = (args[0] || "").toLowerCase();
  const time = (args[1] || "21:00").trim();

  if (!mode) return null;

  const parts = time.split(":");
  if (parts.length !== 2) return null;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { mode, hour, minute };
}

async function handleRemindCommand(admin: ReturnType<typeof createSupabaseAdminClient>, msg: TelegramMessage, args: string[]) {
  if (!msg.from) return;
  const resolved = await requireActiveGroup(admin, msg.from, msg.chat.id, "Para /remind, primero elige grupo activo:");
  if (!resolved) return;
  const { group } = resolved;

  const parsed = parseReminderArgs(args);
  if (!parsed) {
    await sendTelegramMessage(msg.chat.id, "Uso: /remind on [HH:MM] o /remind off");
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
    await sendTelegramMessage(msg.chat.id, "Uso: /remind on [HH:MM] o /remind off");
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

async function handleImplicitShareText(admin: ReturnType<typeof createSupabaseAdminClient>, msg: TelegramMessage, text: string) {
  if (!msg.from) return;

  try {
    parseShareText(text);
  } catch {
    return;
  }

  const resolved = await requireActiveGroup(admin, msg.from, msg.chat.id, "Detecte share text. Selecciona grupo activo para continuar:");
  if (!resolved) return;
  const { appUserId, group } = resolved;

  const pendingId = await createPendingAction(admin, msg.from.id, appUserId, group.id, "submit", { shareText: text });
  await sendTelegramInlineKeyboardMessage(
    msg.chat.id,
    `Detecte un share text. Guardarlo en ${group.name}?`,
    [
      [
        { text: "Confirmar", callback_data: `confirm:${pendingId}` },
        { text: "Cancelar", callback_data: `cancel:${pendingId}` }
      ]
    ]
  );
}

async function handleCallbackQuery(admin: ReturnType<typeof createSupabaseAdminClient>, callback: TelegramCallbackQuery) {
  const data = callback.data || "";
  const chatId = callback.message?.chat.id || callback.from.id;

  if (data.startsWith("set_group:")) {
    const groupId = data.replace("set_group:", "").trim();
    const appUserId = await requireLinkedUser(admin, callback.from, chatId);
    if (!appUserId) {
      await answerTelegramCallbackQuery(callback.id, "Debes enlazar tu cuenta");
      return;
    }

    const groups = await listUserGroups(admin, appUserId);
    const selected = groups.find((g) => g.id === groupId);
    if (!selected) {
      await answerTelegramCallbackQuery(callback.id, "Grupo no valido");
      return;
    }

    await setActiveGroup(admin, callback.from.id, selected.id);
    await answerTelegramCallbackQuery(callback.id, `Grupo activo: ${selected.name}`);
    await sendTelegramMessage(chatId, `Grupo activo cambiado a ${selected.name} (${selected.code}).`);
    return;
  }

  if (data.startsWith("cancel:")) {
    const actionId = data.replace("cancel:", "").trim();
    await admin
      .from("telegram_pending_actions")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", actionId)
      .eq("telegram_user_id", callback.from.id)
      .is("consumed_at", null);
    await answerTelegramCallbackQuery(callback.id, "Cancelado");
    await sendTelegramMessage(chatId, "Operacion cancelada.");
    return;
  }

  if (data.startsWith("confirm:")) {
    const actionId = data.replace("confirm:", "").trim();
    const { data: action } = await admin
      .from("telegram_pending_actions")
      .select("id,telegram_user_id,app_user_id,group_id,action_type,payload,expires_at,consumed_at")
      .eq("id", actionId)
      .eq("telegram_user_id", callback.from.id)
      .maybeSingle();

    if (!action || action.consumed_at) {
      await answerTelegramCallbackQuery(callback.id, "Accion ya usada o inexistente");
      return;
    }

    if (new Date(action.expires_at).getTime() < Date.now()) {
      await admin
        .from("telegram_pending_actions")
        .update({ consumed_at: new Date().toISOString() })
        .eq("id", action.id);
      await answerTelegramCallbackQuery(callback.id, "Accion expirada");
      await sendTelegramMessage(chatId, "La confirmacion expiro. Repite el comando.");
      return;
    }

    await admin
      .from("telegram_pending_actions")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", action.id)
      .is("consumed_at", null);

    const { data: group } = await admin.from("groups").select("id,name,code").eq("id", action.group_id).maybeSingle();
    if (!group) {
      await answerTelegramCallbackQuery(callback.id, "Grupo no encontrado");
      return;
    }

    if (action.action_type === "submit") {
      const shareText = String((action.payload as Record<string, unknown>).shareText || "").trim();
      if (!shareText) {
        await answerTelegramCallbackQuery(callback.id, "Payload invalido");
        return;
      }

      try {
        const saved = await upsertSubmissionFromShare(admin, action.app_user_id as string, action.group_id as string, shareText);
        await answerTelegramCallbackQuery(callback.id, "Guardado");
        await sendTelegramMessage(chatId, `Resultado guardado en ${group.name} (${saved.playedOn}). Intentos: ${saved.attempts}.`);
      } catch (err) {
        await answerTelegramCallbackQuery(callback.id, "Error al guardar");
        await sendTelegramMessage(chatId, `No pude guardar el resultado: ${(err as Error).message}`);
      }
      return;
    }

    if (action.action_type === "comment") {
      const body = String((action.payload as Record<string, unknown>).body || "").trim();
      if (!body) {
        await answerTelegramCallbackQuery(callback.id, "Payload invalido");
        return;
      }

      try {
        const commentDay = await insertGroupComment(admin, action.group_id as string, action.app_user_id as string, body);
        await answerTelegramCallbackQuery(callback.id, "Comentario enviado");
        await sendTelegramMessage(chatId, `Comentario publicado en ${group.name} para ${commentDay}.`);
      } catch (err) {
        await answerTelegramCallbackQuery(callback.id, "Error al comentar");
        await sendTelegramMessage(chatId, `No pude publicar comentario: ${(err as Error).message}`);
      }
      return;
    }

    await answerTelegramCallbackQuery(callback.id, "Tipo de accion no soportado");
    return;
  }

  await answerTelegramCallbackQuery(callback.id, "Accion no reconocida");
}

async function handleMessage(admin: ReturnType<typeof createSupabaseAdminClient>, msg: TelegramMessage) {
  if (!msg.text || !msg.from) return;

  const text = msg.text.trim();
  const { cmd, args } = parseTelegramCommand(text);

  if (cmd === "/start") {
    await sendTelegramMessage(msg.chat.id, `Bot listo.\n\n${helpText()}`);
    return;
  }

  if (cmd === "/help") {
    await sendTelegramMessage(msg.chat.id, helpText());
    return;
  }

  if (cmd === "/link") {
    await handleLinkCommand(admin, msg, args);
    return;
  }

  if (cmd === "/join") {
    await sendTelegramMessage(msg.chat.id, "Para unirte a grupos usa la app web. En el bot usa /groups para elegir grupo activo.");
    return;
  }

  if (cmd === "/groups") {
    await handleGroupsCommand(admin, msg);
    return;
  }

  if (cmd === "/ranking") {
    await handleRankingCommand(admin, msg);
    return;
  }

  if (cmd === "/today") {
    await handleTodayCommand(admin, msg);
    return;
  }

  if (cmd === "/submit") {
    await handleSubmitCommand(admin, msg, text);
    return;
  }

  if (cmd === "/comment") {
    await handleCommentCommand(admin, msg, text);
    return;
  }

  if (cmd === "/remind") {
    await handleRemindCommand(admin, msg, args);
    return;
  }

  await handleImplicitShareText(admin, msg, text);
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
  const admin = createSupabaseAdminClient();

  try {
    if (update.callback_query) {
      await handleCallbackQuery(admin, update.callback_query);
    } else if (update.message) {
      await handleMessage(admin, update.message);
    }
  } catch (err) {
    const chatId = update.message?.chat.id || update.callback_query?.message?.chat.id || update.callback_query?.from.id;
    if (chatId) {
      await sendTelegramMessage(chatId, `Error interno: ${(err as Error).message}`);
    }
  }

  return NextResponse.json({ ok: true, activeDay: getActiveDayISO(), closedDay: getLastClosedDayISO() });
}
