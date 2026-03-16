import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { addDaysToIsoDay, getActiveDayISO, getLastClosedDayISO } from "@/lib/active-day";
import { notifyTelegramGroupMembers } from "@/lib/telegram-group-notify";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CommentItem } from "@/components/groups/comment-item";
import { ShareGroupButton } from "@/components/groups/share-group-button";
import { SubmitOnceButton } from "@/components/ui/submit-once-button";

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function moveDay(dateText: string, delta: number) {
  return addDaysToIsoDay(dateText, delta);
}

function dateRange(from: string, to: string) {
  const out: string[] = [];
  let d = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (d <= end) {
    out.push(ymd(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function displayName(value: string | null | undefined) {
  return value || "Usuario";
}

function initials(label: string) {
  return label.slice(0, 2).toUpperCase();
}

export default async function GroupDetailPage({
  params,
  searchParams
}: {
  params: Promise<{ groupId: string }>;
  searchParams: Promise<{ date?: string; notice?: string; error?: string }>;
}) {
  const { groupId } = await params;
  const { date, notice, error } = await searchParams;
  const activeDay = getActiveDayISO();
  const lastClosedDay = getLastClosedDayISO();
  const selectedDate = date || activeDay;
  const supabase = await createSupabaseServerClient();

  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: membership } = await supabase
    .from("group_members")
    .select("group_id,role")
    .eq("group_id", groupId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) notFound();

  await supabase.rpc("recalc_group_if_needed", { p_group_id: groupId });

  const [
    { data: group },
    { data: allSubmissions },
    { data: daySubmissions },
    { data: members },
    { data: profiles },
    { data: gameTypes },
    { data: allCorrections },
    { data: dayCorrections },
    { data: dayComments }
  ] = await Promise.all([
    supabase.from("groups").select("id,name,code,icon_url,owner_id,entry_mode,penalties_enabled").eq("id", groupId).single(),
    supabase.from("submissions").select("user_id,attempts,played_on,game_type_id").eq("group_id", groupId).lte("played_on", selectedDate),
    supabase
      .from("submissions")
      .select("id,user_id,attempts,grid_rows,game_type_id,played_on,created_at")
      .eq("group_id", groupId)
      .eq("played_on", selectedDate)
      .order("created_at", { ascending: false }),
    supabase.from("group_members").select("user_id,role,joined_at,initial_points").eq("group_id", groupId),
    supabase.from("profiles").select("id,username,avatar_url"),
    supabase.from("game_types").select("id,label,max_attempts").eq("active", true),
    supabase
      .from("group_member_day_corrections")
      .select("user_id,played_on,game_type_id,effective_attempts,reason")
      .eq("group_id", groupId)
      .lte("played_on", selectedDate),
    supabase
      .from("group_member_day_corrections")
      .select("user_id,played_on,game_type_id,effective_attempts,reason")
      .eq("group_id", groupId)
      .eq("played_on", selectedDate),
    supabase
      .from("group_comments")
      .select("id,user_id,body,created_at,parent_comment_id")
      .eq("group_id", groupId)
      .eq("comment_date", selectedDate)
      .order("created_at", { ascending: true })
  ]);

  if (!group) notFound();
  const isOwner = membership.role === "owner" || group.owner_id === user.id;
  const isPrimaryOwner = group.owner_id === user.id;

  const updateGroupMeta = async (formData: FormData) => {
    "use server";
    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");

    const nextName = String(formData.get("name") || "").trim();
    const nextIcon = String(formData.get("icon_url") || "").trim();
    const nextMode = String(formData.get("entry_mode") || "daily").trim() === "history" ? "history" : "daily";
    if (!nextName) throw new Error("El nombre no puede estar vacio.");

    const { error } = await supabaseServer
      .from("groups")
      .update({ name: nextName, icon_url: nextIcon || null, entry_mode: nextMode })
      .eq("id", groupId)
      .eq("owner_id", currentUser.id);

    if (error) throw new Error(`No se pudo actualizar grupo: ${error.message}`);
    redirect(`/groups/${groupId}?date=${selectedDate}&notice=settings_saved`);
  };

  const kickMember = async (formData: FormData) => {
    "use server";
    const targetUserId = String(formData.get("targetUserId") || "");
    if (!targetUserId) return;
    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");
    await supabaseServer.rpc("remove_group_member", { p_group_id: groupId, p_user_id: targetUserId });
    redirect(`/groups/${groupId}?date=${selectedDate}&notice=member_removed`);
  };

  const setPenaltiesEnabled = async (formData: FormData) => {
    "use server";
    const enabled = String(formData.get("enabled") || "off") === "on";
    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");
    await supabaseServer.rpc("set_group_penalties_enabled", { p_group_id: groupId, p_enabled: enabled });
    redirect(`/groups/${groupId}?date=${selectedDate}&notice=settings_saved`);
  };

  const setMemberInitialPoints = async (formData: FormData) => {
    "use server";
    const targetUserId = String(formData.get("targetUserId") || "");
    const points = Number(formData.get("initial_points") || 0);
    const safePoints = Number.isFinite(points) ? Math.max(0, Math.trunc(points)) : 0;
    if (!targetUserId) return;
    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");
    const { error: rpcError } = await supabaseServer.rpc("set_group_member_initial_points", {
      p_group_id: groupId,
      p_user_id: targetUserId,
      p_points: safePoints
    });
    if (rpcError) {
      const reason = encodeURIComponent((rpcError.message || "unknown_error").slice(0, 180));
      redirect(`/groups/${groupId}?date=${selectedDate}&notice=settings_failed&error=${reason}`);
    }
    redirect(`/groups/${groupId}?date=${selectedDate}&notice=settings_saved`);
  };

  const setMemberDayCorrection = async (formData: FormData) => {
    "use server";
    const targetUserId = String(formData.get("targetUserId") || "");
    const playedOn = String(formData.get("played_on") || "").trim();
    const gameTypeId = Number(formData.get("game_type_id") || 0);
    const effectiveAttemptsRaw = Number(formData.get("effective_attempts") || 0);
    const reason = String(formData.get("reason") || "").trim();
    if (!targetUserId || !playedOn || !Number.isFinite(gameTypeId)) return;

    const effectiveAttempts = Number.isFinite(effectiveAttemptsRaw) ? Math.max(0, Math.trunc(effectiveAttemptsRaw)) : 0;
    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");

    const { error: rpcError } = await supabaseServer.rpc("set_group_member_day_correction", {
      p_group_id: groupId,
      p_user_id: targetUserId,
      p_played_on: playedOn,
      p_game_type_id: gameTypeId,
      p_effective_attempts: effectiveAttempts,
      p_reason: reason || null
    });
    if (rpcError) {
      const reasonText = encodeURIComponent((rpcError.message || "unknown_error").slice(0, 180));
      redirect(`/groups/${groupId}?date=${selectedDate}&notice=settings_failed&error=${reasonText}`);
    }
    redirect(`/groups/${groupId}?date=${selectedDate}&notice=settings_saved`);
  };

  const clearMemberDayCorrection = async (formData: FormData) => {
    "use server";
    const targetUserId = String(formData.get("targetUserId") || "");
    const playedOn = String(formData.get("played_on") || "").trim();
    const gameTypeId = Number(formData.get("game_type_id") || 0);
    if (!targetUserId || !playedOn || !Number.isFinite(gameTypeId)) return;

    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");

    const { error: rpcError } = await supabaseServer.rpc("clear_group_member_day_correction", {
      p_group_id: groupId,
      p_user_id: targetUserId,
      p_played_on: playedOn,
      p_game_type_id: gameTypeId
    });
    if (rpcError) {
      const reasonText = encodeURIComponent((rpcError.message || "unknown_error").slice(0, 180));
      redirect(`/groups/${groupId}?date=${selectedDate}&notice=settings_failed&error=${reasonText}`);
    }
    redirect(`/groups/${groupId}?date=${selectedDate}&notice=settings_saved`);
  };

  const resetSeason = async () => {
    "use server";
    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");
    await supabaseServer.rpc("reset_group_season", { p_group_id: groupId });
    redirect(`/groups/${groupId}?date=${selectedDate}&notice=recalculated`);
  };

  const promoteMember = async (formData: FormData) => {
    "use server";
    const targetUserId = String(formData.get("targetUserId") || "");
    if (!targetUserId) return;
    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");
    await supabaseServer.rpc("promote_group_member_to_owner", { p_group_id: groupId, p_user_id: targetUserId });
    redirect(`/groups/${groupId}?date=${selectedDate}&notice=settings_saved`);
  };

  const demoteOwner = async (formData: FormData) => {
    "use server";
    const targetUserId = String(formData.get("targetUserId") || "");
    if (!targetUserId) return;
    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");
    await supabaseServer.rpc("demote_group_owner_to_member", { p_group_id: groupId, p_user_id: targetUserId });
    redirect(`/groups/${groupId}?date=${selectedDate}&notice=settings_saved`);
  };

  const addComment = async (formData: FormData) => {
    "use server";
    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");

    const body = String(formData.get("body") || "").trim();
    const parentCommentId = String(formData.get("parentCommentId") || "").trim();
    if (!body) redirect(`/groups/${groupId}?date=${selectedDate}&notice=comment_empty`);
    if (body.length > 280) redirect(`/groups/${groupId}?date=${selectedDate}&notice=comment_too_long`);

    if (parentCommentId) {
      const { data: parent } = await supabaseServer
        .from("group_comments")
        .select("id")
        .eq("id", parentCommentId)
        .eq("group_id", groupId)
        .eq("comment_date", selectedDate)
        .maybeSingle();
      if (!parent) redirect(`/groups/${groupId}?date=${selectedDate}&notice=comment_edit_failed`);
    }

    await supabaseServer.from("group_comments").insert({
      group_id: groupId,
      user_id: currentUser.id,
      comment_date: selectedDate,
      body,
      parent_comment_id: parentCommentId || null
    });

    const { data: actorProfile } = await supabaseServer.from("profiles").select("username").eq("id", currentUser.id).maybeSingle();
    const actorName = actorProfile?.username || currentUser.email?.split("@")[0] || "Usuario";
    const kind = parentCommentId ? "respuesta" : "comentario";
    await notifyTelegramGroupMembers({
      groupId,
      actorUserId: currentUser.id,
      text: `Nueva ${kind} en ${group.name} (${selectedDate}):\n${actorName}: ${body}`
    });

    redirect(`/groups/${groupId}?date=${selectedDate}&notice=comment_added`);
  };

  const profileMap = new Map((profiles || []).map((p) => [p.id, p]));
  const initialPointsByUser = new Map((members || []).map((m) => [m.user_id, m.initial_points || 0]));
  const attemptsByUserDayGame = new Map<string, number>();
  for (const item of allSubmissions || []) {
    const keyByGame = `${item.user_id}:${item.played_on}:${item.game_type_id}`;
    attemptsByUserDayGame.set(keyByGame, item.attempts);
  }
  const correctionsByUserDayGame = new Map<string, { attempts: number; reason: string | null }>();
  for (const c of allCorrections || []) {
    const key = `${c.user_id}:${c.played_on}:${c.game_type_id}`;
    correctionsByUserDayGame.set(key, { attempts: c.effective_attempts, reason: c.reason || null });
  }
  const dayCorrectionsByUser = new Map<string, Array<{ gameTypeId: number; attempts: number; reason: string | null }>>();
  for (const c of dayCorrections || []) {
    const list = dayCorrectionsByUser.get(c.user_id) || [];
    list.push({ gameTypeId: c.game_type_id, attempts: c.effective_attempts, reason: c.reason || null });
    dayCorrectionsByUser.set(c.user_id, list);
  }

  const rankingData: Array<{
    userId: string;
    score: number;
    name: string;
    avatar: string | null;
    role: string;
    dayPoints: number;
    dayPenaltyPoints: number;
    previousScore: number;
    dayGamesCount: number;
    dayPenaltyApplied: boolean;
  }> = [];
  const penaltyThroughDay = selectedDate < lastClosedDay ? selectedDate : lastClosedDay;

  const activeGames = (gameTypes || []).map((g) => ({ id: g.id, maxAttempts: g.max_attempts }));
  const penaltyDaysForCurrentUser: Array<{ day: string; penaltyPoints: number; missingGames: number }> = [];

  const currentMember = (members || []).find((m) => m.user_id === user.id);
  if (group.penalties_enabled && currentMember && currentMember.joined_at) {
    const joinedOn = ymd(new Date(currentMember.joined_at));
    if (joinedOn <= penaltyThroughDay) {
      const effectiveByGame = new Map<number, number>();
      for (const day of dateRange(joinedOn, penaltyThroughDay)) {
        let dayPenaltyPoints = 0;
        let missingGames = 0;

        for (const g of activeGames) {
          const key = `${user.id}:${day}:${g.id}`;
          const dayCorrection = correctionsByUserDayGame.get(key);
          const todayByGame = attemptsByUserDayGame.get(key);

          if (dayCorrection) {
            effectiveByGame.set(g.id, dayCorrection.attempts);
            continue;
          }

          if (typeof todayByGame === "number") {
            effectiveByGame.set(g.id, todayByGame);
            continue;
          }

          missingGames += 1;

          let prevEffective = effectiveByGame.get(g.id);
          if (typeof prevEffective !== "number") {
            let scan = moveDay(day, -1);
            while (scan >= joinedOn) {
              const prevKey = `${user.id}:${scan}:${g.id}`;
              const prevCorrection = correctionsByUserDayGame.get(prevKey);
              const value = attemptsByUserDayGame.get(prevKey);
              if (prevCorrection) {
                prevEffective = prevCorrection.attempts;
                break;
              }
              if (typeof value === "number") {
                prevEffective = value;
                break;
              }
              scan = moveDay(scan, -1);
            }
          }

          const penalty = (prevEffective ?? g.maxAttempts) + 1;
          dayPenaltyPoints += penalty;
          effectiveByGame.set(g.id, penalty);
        }

        if (dayPenaltyPoints > 0) {
          penaltyDaysForCurrentUser.push({ day, penaltyPoints: dayPenaltyPoints, missingGames });
        }
      }
    }
  }

  for (const member of members || []) {
    const joinedOn = ymd(new Date(member.joined_at));
    let previousScore = member.initial_points || 0;
    let dayPenaltyPoints = 0;
    let dayPenaltyApplied = false;
    let dayPoints = 0;
    let dayGamesCount = 0;
    const effectiveByGame = new Map<number, number>();
    const allDays = joinedOn <= selectedDate ? dateRange(joinedOn, selectedDate) : [];

    for (const day of allDays) {
      let dayNonPenalty = 0;
      let dayPenalty = 0;
      let dayCoveredGames = 0;

      for (const g of activeGames) {
        const key = `${member.user_id}:${day}:${g.id}`;
        const correction = correctionsByUserDayGame.get(key);
        const submission = attemptsByUserDayGame.get(key);

        if (correction) {
          previousScore += correction.attempts;
          dayNonPenalty += correction.attempts;
          dayCoveredGames += 1;
          effectiveByGame.set(g.id, correction.attempts);
          continue;
        }

        if (typeof submission === "number") {
          previousScore += submission;
          dayNonPenalty += submission;
          dayCoveredGames += 1;
          effectiveByGame.set(g.id, submission);
          continue;
        }

        if (group.penalties_enabled && day <= penaltyThroughDay) {
          let prevEffective = effectiveByGame.get(g.id);
          if (typeof prevEffective !== "number") {
            let scan = moveDay(day, -1);
            while (scan >= joinedOn) {
              const prevKey = `${member.user_id}:${scan}:${g.id}`;
              const prevCorrection = correctionsByUserDayGame.get(prevKey);
              const prevSubmission = attemptsByUserDayGame.get(prevKey);
              if (prevCorrection) {
                prevEffective = prevCorrection.attempts;
                break;
              }
              if (typeof prevSubmission === "number") {
                prevEffective = prevSubmission;
                break;
              }
              scan = moveDay(scan, -1);
            }
          }

          const penalty = (prevEffective ?? g.maxAttempts) + 1;
          previousScore += penalty;
          dayPenalty += penalty;
          effectiveByGame.set(g.id, penalty);
        }
      }

      if (day === selectedDate) {
        dayPoints = dayNonPenalty;
        dayPenaltyPoints = dayPenalty;
        dayGamesCount = dayCoveredGames;
        dayPenaltyApplied = dayPenalty > 0;
      }
    }

    const total = previousScore;

    rankingData.push({
      userId: member.user_id,
      score: total,
      previousScore: Math.max(0, previousScore),
      dayPoints,
      dayPenaltyPoints,
      dayGamesCount,
      dayPenaltyApplied,
      name: displayName(profileMap.get(member.user_id)?.username),
      avatar: profileMap.get(member.user_id)?.avatar_url ?? null,
      role: member.role
    });
  }

  const ranking = rankingData.sort((a, b) => a.score - b.score);
  const bestScore = ranking.length > 0 ? ranking[0].score : 0;
  const worstScore = ranking.length > 0 ? ranking[ranking.length - 1].score : 0;
  const scoreRange = Math.max(1, worstScore - bestScore);
  const visualMargin = Math.max(1, Math.ceil(scoreRange * 0.2));
  const visualMin = bestScore - visualMargin;
  const visualMax = worstScore + visualMargin;
  const visualSpan = Math.max(1, visualMax - visualMin);
  const raceData = ranking.map((r) => ({
    ...r,
    progress: Math.max(8, Math.min(100, Math.round(((visualMax - r.score) / visualSpan) * 100)))
  }));
  const requiredGames = Math.max(1, (gameTypes || []).length);

  const prevDate = moveDay(selectedDate, -1);
  const nextDate = moveDay(selectedDate, 1);
  const isToday = selectedDate >= activeDay;
  const noticeText =
    notice === "recalculated"
      ? "Puntuaciones recalculadas."
      : notice === "member_removed"
        ? "Miembro expulsado del grupo."
        : notice === "settings_saved"
          ? "Configuracion del grupo guardada."
          : notice === "settings_failed"
            ? `No se pudo guardar la configuracion${error ? `: ${error}` : "."}`
            : notice === "comment_added"
            ? "Comentario publicado."
            : notice === "comment_empty"
              ? "Escribe un comentario antes de enviar."
          : notice === "comment_too_long"
                ? "El comentario supera 280 caracteres."
                : notice === "comment_edited"
                  ? "Comentario actualizado."
                  : notice === "comment_deleted"
                    ? "Comentario eliminado."
                    : notice === "comment_edit_failed"
                      ? "No se pudo editar el comentario."
                      : notice === "comment_delete_failed"
                        ? "No se pudo eliminar el comentario."
                : null;
  const comments = dayComments || [];
  const rootComments = comments.filter((c) => !c.parent_comment_id);
  const childrenByParent = new Map<string, Array<(typeof comments)[number]>>();
  for (const c of comments) {
    if (!c.parent_comment_id) continue;
    const list = childrenByParent.get(c.parent_comment_id) || [];
    list.push(c);
    childrenByParent.set(c.parent_comment_id, list);
  }
  type DaySubmission = NonNullable<typeof daySubmissions>[number];
  const daySubmissionsByUser = new Map<string, DaySubmission[]>();
  for (const s of daySubmissions || []) {
    const list = daySubmissionsByUser.get(s.user_id) || [];
    list.push(s);
    daySubmissionsByUser.set(s.user_id, list);
  }
  const groupedDaySubmissions = [...daySubmissionsByUser.entries()].map(([userId, submissions]) => ({
    userId,
    submissions: submissions
      .slice()
      .sort((a, b) => {
        const aLabel = gameTypes?.find((g) => g.id === a.game_type_id)?.label || "";
        const bLabel = gameTypes?.find((g) => g.id === b.game_type_id)?.label || "";
        return aLabel.localeCompare(bLabel, "es");
      })
  }));

  return (
    <section className="space-y-4">
      {noticeText ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{noticeText}</div> : null}

      <div className="panel space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {group.icon_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={group.icon_url} alt="Icono grupo" className="h-12 w-12 rounded-xl object-cover" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src="/default-group-logo.svg" alt="Icono grupo por defecto" className="h-12 w-12 rounded-xl object-cover" />
            )}
            <div>
              <h1 className="title-xl">{group.name}</h1>
              <p className="muted">
                Codigo: {group.code} - Modo: {group.entry_mode === "history" ? "historial" : "diario"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ShareGroupButton groupCode={group.code} />
            <Link className="button-secondary h-10 rounded-full px-4" href="/groups" aria-label="Inicio" title="Inicio">
              Menu
            </Link>
          </div>
        </div>
        <Link className="button-primary w-full" href={`/submit?groupId=${group.id}`}>
          Registrar jugada
        </Link>

        {isOwner ? (
          <details className="rounded-xl border border-slate-200 bg-white p-3">
            <summary className="cursor-pointer text-sm font-semibold">Gestion del grupo (owner)</summary>
            <form action={updateGroupMeta} className="mt-3 space-y-3">
              <input className="input" name="name" defaultValue={group.name} required />
              <input className="input" name="icon_url" defaultValue={group.icon_url ?? ""} placeholder="URL icono" />
              <select className="input" name="entry_mode" defaultValue={group.entry_mode}>
                <option value="daily">Modo diario (solo hoy)</option>
                <option value="history">Modo historial (elegir fecha)</option>
              </select>
              <SubmitOnceButton className="button-secondary w-full" pendingText="Guardando...">
                Guardar cambios
              </SubmitOnceButton>
            </form>
            <form action={setPenaltiesEnabled} className="mt-3 rounded-lg border border-slate-200 p-3">
              <label className="flex items-center justify-between text-sm font-medium">
                <span>Penalizaciones</span>
                <input type="checkbox" name="enabled" defaultChecked={group.penalties_enabled} />
              </label>
              <SubmitOnceButton className="button-secondary mt-3 w-full" pendingText="Aplicando...">
                Aplicar
              </SubmitOnceButton>
            </form>
            <form action={resetSeason} className="mt-3">
              <SubmitOnceButton className="button-secondary w-full border-red-200 bg-red-50 text-red-700 hover:bg-red-100" pendingText="Restaurando...">
                Restaurar temporada (reset)
              </SubmitOnceButton>
            </form>
            <div className="mt-3 space-y-2">
              <p className="text-sm font-semibold">Miembros</p>
              {ranking.map((m) => (
                <div key={m.userId} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                  <div>
                    <p className="text-sm">
                      {m.name} {m.role === "owner" ? "(owner)" : ""}
                    </p>
                    <form action={setMemberInitialPoints} className="mt-2 flex items-center gap-2">
                      <input type="hidden" name="targetUserId" value={m.userId} />
                      <input
                        className="input h-8 w-20"
                        name="initial_points"
                        type="number"
                        min={0}
                        step={1}
                        defaultValue={initialPointsByUser.get(m.userId) ?? 0}
                      />
                      <SubmitOnceButton className="button-secondary h-8 px-3 text-xs" pendingText="...">
                        Base
                      </SubmitOnceButton>
                    </form>
                    <form action={setMemberDayCorrection} className="mt-2 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
                      <input type="hidden" name="targetUserId" value={m.userId} />
                      <input type="hidden" name="played_on" value={selectedDate} />
                      <p className="text-xs font-semibold text-amber-800">Correccion ({selectedDate})</p>
                      <div className="flex items-center gap-2">
                        <select className="input h-8 min-w-28" name="game_type_id" defaultValue={String(gameTypes?.[0]?.id || "")} required>
                          {(gameTypes || []).map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.label}
                            </option>
                          ))}
                        </select>
                        <input className="input h-8 w-20" name="effective_attempts" type="number" min={0} step={1} placeholder="Pts" required />
                      </div>
                      <input className="input h-8 w-full" name="reason" placeholder="Motivo (opcional)" />
                      <SubmitOnceButton className="button-secondary h-8 w-full text-xs" pendingText="...">
                        Guardar correccion
                      </SubmitOnceButton>
                    </form>
                    {(dayCorrectionsByUser.get(m.userId) || []).map((c) => {
                      const gameLabel = gameTypes?.find((g) => g.id === c.gameTypeId)?.label || "Juego";
                      return (
                        <form key={`${m.userId}:${c.gameTypeId}`} action={clearMemberDayCorrection} className="mt-2 flex items-center justify-between rounded-lg border border-amber-200 bg-white px-2 py-1">
                          <input type="hidden" name="targetUserId" value={m.userId} />
                          <input type="hidden" name="played_on" value={selectedDate} />
                          <input type="hidden" name="game_type_id" value={c.gameTypeId} />
                          <p className="text-xs text-amber-900">
                            {gameLabel}: {c.attempts} {c.reason ? `· ${c.reason}` : ""}
                          </p>
                          <SubmitOnceButton className="button-secondary h-7 px-2 text-xs" pendingText="...">
                            Quitar
                          </SubmitOnceButton>
                        </form>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2">
                    {m.role !== "owner" && isPrimaryOwner ? (
                      <form action={promoteMember}>
                        <input type="hidden" name="targetUserId" value={m.userId} />
                        <SubmitOnceButton className="button-secondary h-8 px-3 text-xs" pendingText="...">
                          Hacer owner
                        </SubmitOnceButton>
                      </form>
                    ) : null}
                    {m.role === "owner" && m.userId !== group.owner_id ? (
                      <form action={demoteOwner}>
                        <input type="hidden" name="targetUserId" value={m.userId} />
                        <SubmitOnceButton className="button-secondary h-8 px-3 text-xs" pendingText="...">
                          Quitar owner
                        </SubmitOnceButton>
                      </form>
                    ) : null}
                    {m.userId !== group.owner_id ? (
                      <form action={kickMember}>
                        <input type="hidden" name="targetUserId" value={m.userId} />
                        <SubmitOnceButton className="button-secondary h-8 px-3 text-xs" pendingText="...">
                          Expulsar
                        </SubmitOnceButton>
                      </form>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>

      <div className="panel space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Leaderboard</h2>
          <p className="text-sm font-semibold">{selectedDate}</p>
        </div>
        <div className="space-y-2">
          {raceData.map((r) => (
            // Show daily contribution as +X (normal) or +X+P when penalty was applied.
            // X = submissions of selected day, P = penalties generated for selected day.
            // Example: +0+5 means no submission but 5 penalty points were added.
            // This mirrors the effective score delta for the day.
            (() => {
              const dayDeltaLabel = r.dayPenaltyPoints > 0 ? `${r.dayPoints}+${r.dayPenaltyPoints}` : `${r.dayPoints}`;
              return (
            <div key={r.userId} className="rounded-xl border border-slate-200 bg-white p-2">
              <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                <span>{r.name}</span>
                <span className="text-sky-700">{r.score} pts</span>
              </div>
              <div
                className={`relative h-9 rounded-lg ${
                  r.dayPenaltyApplied
                    ? "bg-rose-300"
                    : r.dayGamesCount === 0
                      ? "bg-slate-200"
                      : r.dayGamesCount < requiredGames
                        ? "bg-sky-200"
                        : "bg-emerald-200"
                }`}
              >
                <div className="absolute left-0 top-0 h-9 rounded-lg bg-slate-900/10" style={{ width: `${r.progress}%` }} />
                <div className="absolute top-1/2 -translate-y-1/2" style={{ left: `calc(${r.progress}% - 18px)` }}>
                  {r.avatar ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.avatar} alt={r.name} className="h-8 w-8 rounded-full border border-white object-cover shadow" />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-full border border-white bg-slate-300 text-[10px] font-semibold text-slate-700 shadow">
                      {initials(r.name)}
                    </div>
                  )}
                </div>
                <div className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-800">+{dayDeltaLabel}</div>
              </div>
            </div>
              );
            })()
          ))}
        </div>
      </div>

      <div className="panel space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Tus penalizaciones</h2>
          <p className="text-xs text-slate-500">Hasta {penaltyThroughDay}</p>
        </div>
        {!group.penalties_enabled ? (
          <p className="muted">Las penalizaciones estan desactivadas en este grupo.</p>
        ) : penaltyDaysForCurrentUser.length === 0 ? (
          <p className="muted">No tienes dias con penalizacion en el rango actual.</p>
        ) : (
          <div className="space-y-2">
            {penaltyDaysForCurrentUser
              .slice()
              .reverse()
              .map((p) => (
                <div key={p.day} className="flex items-center justify-between rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
                  <div>
                    <p className="text-sm font-semibold text-rose-800">{p.day}</p>
                    <p className="text-xs text-rose-700">Faltaron {p.missingGames} juego(s)</p>
                  </div>
                  <p className="text-sm font-semibold text-rose-800">+{p.penaltyPoints} penalizacion</p>
                </div>
              ))}
          </div>
        )}
      </div>

      <div className="panel space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Resultados del dia</h2>
          <div className="flex items-center gap-2">
            <Link className="button-secondary h-9 px-3" href={`/groups/${group.id}?date=${prevDate}`}>
              {"<"}
            </Link>
            <p className="min-w-28 text-center text-sm font-semibold">{selectedDate}</p>
            {isToday ? (
              <span className="button-secondary h-9 cursor-not-allowed px-3 opacity-50">{">"}</span>
            ) : (
              <Link className="button-secondary h-9 px-3" href={`/groups/${group.id}?date=${nextDate}`}>
                {">"}
              </Link>
            )}
          </div>
        </div>

        {groupedDaySubmissions.length === 0 ? (
          <p className="muted">No hay resultados para este dia.</p>
        ) : (
          <div className="space-y-3">
            {groupedDaySubmissions.map((entry) => {
              const author = profileMap.get(entry.userId);
              const authorName = displayName(author?.username);
              return (
                <article key={entry.userId} className="rounded-xl border border-slate-200 bg-white p-3">
                  <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
                    <span className="flex items-center gap-2">
                      {author?.avatar_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={author.avatar_url} alt={authorName} className="h-6 w-6 rounded-full object-cover" />
                      ) : (
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-200 text-[10px] font-semibold text-slate-700">
                          {initials(authorName)}
                        </span>
                      )}
                      <span>{authorName}</span>
                    </span>
                    <span>{entry.submissions.length} resultado{entry.submissions.length > 1 ? "s" : ""}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {entry.submissions.map((s) => {
                      const gameLabel = gameTypes?.find((g) => g.id === s.game_type_id)?.label || "Juego";
                      const itemClass = entry.submissions.length === 1 ? "col-span-2" : "";
                      return (
                        <div key={s.id} className={`rounded-lg border border-slate-100 bg-slate-50 p-2 ${itemClass}`}>
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{gameLabel}</p>
                          <div className="font-mono text-sm leading-5">
                            {(s.grid_rows as string[]).map((line: string, i: number) => (
                              <p key={i}>{line}</p>
                            ))}
                          </div>
                          <p className="mt-2 text-sm font-medium">Intentos: {s.attempts}</p>
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="panel space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Chat del dia</h2>
          <span className="text-xs text-slate-500">Max 280 caracteres</span>
        </div>
        <form action={addComment} className="space-y-2">
          <textarea
            name="body"
            maxLength={280}
            className="min-h-20 w-full rounded-xl border border-slate-300 p-3 text-sm outline-none focus:border-sky-500"
            placeholder={`Comenta sobre las jugadas de ${selectedDate}...`}
            required
          />
          <SubmitOnceButton className="button-secondary w-full" pendingText="Publicando...">
            Publicar comentario
          </SubmitOnceButton>
        </form>

        {comments.length === 0 ? (
          <p className="muted">Aun no hay comentarios en este dia.</p>
        ) : (
          <div className="space-y-2">
            {rootComments.map((c) => {
              const author = profileMap.get(c.user_id);
              const authorName = displayName(author?.username);
              const canManage = c.user_id === user.id || isOwner;
              const replies = childrenByParent.get(c.id) || [];
              return (
                <div key={c.id} className="space-y-2">
                  <CommentItem
                    commentId={c.id}
                    body={c.body}
                    createdAt={c.created_at}
                    authorName={authorName}
                    authorAvatarUrl={author?.avatar_url ?? null}
                    canManage={canManage}
                    groupId={group.id}
                    selectedDate={selectedDate}
                  />
                  <details className="ml-5 rounded-lg border border-slate-200 bg-slate-50 p-2">
                    <summary className="cursor-pointer text-xs font-semibold text-slate-600">Responder</summary>
                    <form action={addComment} className="mt-2 space-y-2">
                      <input type="hidden" name="parentCommentId" value={c.id} />
                      <textarea
                        name="body"
                        maxLength={280}
                        className="min-h-14 w-full rounded-lg border border-slate-300 p-2 text-sm outline-none focus:border-sky-500"
                        placeholder="Escribe tu respuesta..."
                        required
                      />
                      <SubmitOnceButton className="button-secondary h-8 w-full text-xs" pendingText="Enviando...">
                        Publicar respuesta
                      </SubmitOnceButton>
                    </form>
                  </details>
                  {replies.map((r) => {
                    const replyAuthor = profileMap.get(r.user_id);
                    const replyAuthorName = displayName(replyAuthor?.username);
                    const canManageReply = r.user_id === user.id || isOwner;
                    return (
                      <CommentItem
                        key={r.id}
                        commentId={r.id}
                        body={r.body}
                        createdAt={r.created_at}
                        authorName={replyAuthorName}
                        authorAvatarUrl={replyAuthor?.avatar_url ?? null}
                        canManage={canManageReply}
                        groupId={group.id}
                        selectedDate={selectedDate}
                        depth={1}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
