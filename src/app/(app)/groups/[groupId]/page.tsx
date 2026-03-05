import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CommentItem } from "@/components/groups/comment-item";
import { ShareGroupButton } from "@/components/groups/share-group-button";
import { SubmitOnceButton } from "@/components/ui/submit-once-button";

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function moveDay(dateText: string, delta: number) {
  const d = new Date(`${dateText}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return ymd(d);
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
  searchParams: Promise<{ date?: string; notice?: string }>;
}) {
  const { groupId } = await params;
  const { date, notice } = await searchParams;
  const selectedDate = date || ymd(new Date());
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
    const { error } = await supabaseServer.rpc("set_group_member_initial_points", {
      p_group_id: groupId,
      p_user_id: targetUserId,
      p_points: safePoints
    });
    if (error) {
      redirect(`/groups/${groupId}?date=${selectedDate}&notice=settings_failed`);
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

    redirect(`/groups/${groupId}?date=${selectedDate}&notice=comment_added`);
  };

  const profileMap = new Map((profiles || []).map((p) => [p.id, p]));
  const initialPointsByUser = new Map((members || []).map((m) => [m.user_id, m.initial_points || 0]));
  const attemptsByUserDay = new Map<string, number>();
  const attemptsByUserDayGame = new Map<string, number>();
  for (const item of allSubmissions || []) {
    const key = `${item.user_id}:${item.played_on}`;
    attemptsByUserDay.set(key, (attemptsByUserDay.get(key) || 0) + item.attempts);
    const keyByGame = `${item.user_id}:${item.played_on}:${item.game_type_id}`;
    attemptsByUserDayGame.set(keyByGame, item.attempts);
  }

  const rankingData: Array<{
    userId: string;
    score: number;
    name: string;
    avatar: string | null;
    role: string;
    dayPoints: number;
    previousScore: number;
    dayGamesCount: number;
  }> = [];
  const yesterday = moveDay(ymd(new Date()), -1);
  const penaltyThroughDay = selectedDate < yesterday ? selectedDate : yesterday;

  const activeGames = (gameTypes || []).map((g) => ({ id: g.id, maxAttempts: g.max_attempts }));

  for (const member of members || []) {
    const joinedOn = ymd(new Date(member.joined_at));
    let previousScore = member.initial_points || 0;
    let penaltyTotal = 0;

    if (joinedOn <= moveDay(selectedDate, -1)) {
      for (const day of dateRange(joinedOn, moveDay(selectedDate, -1))) {
        previousScore += attemptsByUserDay.get(`${member.user_id}:${day}`) || 0;
      }
    }

    if (group.penalties_enabled && joinedOn <= penaltyThroughDay) {
      for (const day of dateRange(joinedOn, penaltyThroughDay)) {
        for (const g of activeGames) {
          const hasSubmission = attemptsByUserDayGame.has(`${member.user_id}:${day}:${g.id}`);
          if (hasSubmission) continue;

          let prevAttempts: number | null = null;
          let scan = moveDay(day, -1);
          while (scan >= joinedOn) {
            const value = attemptsByUserDayGame.get(`${member.user_id}:${scan}:${g.id}`);
            if (typeof value === "number") {
              prevAttempts = value;
              break;
            }
            scan = moveDay(scan, -1);
          }

          penaltyTotal += (prevAttempts ?? g.maxAttempts) + 1;
        }
      }
    }

    previousScore += penaltyTotal;
    const dayPoints = attemptsByUserDay.get(`${member.user_id}:${selectedDate}`) || 0;
    const dayGamesCount = (daySubmissions || []).filter((s) => s.user_id === member.user_id).length;
    const total = previousScore + dayPoints;

    rankingData.push({
      userId: member.user_id,
      score: total,
      previousScore: Math.max(0, previousScore),
      dayPoints,
      dayGamesCount,
      name: displayName(profileMap.get(member.user_id)?.username),
      avatar: profileMap.get(member.user_id)?.avatar_url ?? null,
      role: member.role
    });
  }

  const ranking = rankingData.sort((a, b) => a.score - b.score);
  const raceMax = Math.max(1, ...ranking.map((r) => r.score));
  const raceData = ranking.map((r) => ({
    ...r,
    progress: Math.max(8, Math.round(((raceMax - r.score + 1) / (raceMax + 1)) * 100))
  }));
  const requiredGames = Math.max(1, (gameTypes || []).length);

  const prevDate = moveDay(selectedDate, -1);
  const nextDate = moveDay(selectedDate, 1);
  const isToday = selectedDate >= ymd(new Date());
  const noticeText =
    notice === "recalculated"
      ? "Puntuaciones recalculadas."
      : notice === "member_removed"
        ? "Miembro expulsado del grupo."
        : notice === "settings_saved"
          ? "Configuracion del grupo guardada."
          : notice === "settings_failed"
            ? "No se pudo guardar la configuracion."
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
            <div key={r.userId} className="rounded-xl border border-slate-200 bg-white p-2">
              <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                <span>{r.name}</span>
                <span className="text-sky-700">{r.score} pts</span>
              </div>
              <div
                className={`relative h-9 rounded-lg ${
                  r.dayGamesCount === 0 ? "bg-slate-200" : r.dayGamesCount < requiredGames ? "bg-sky-200" : "bg-emerald-200"
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
                <div className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-semibold text-slate-800">+{r.dayPoints}</div>
              </div>
            </div>
          ))}
        </div>
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

        {(daySubmissions || []).length === 0 ? (
          <p className="muted">No hay resultados para este dia.</p>
        ) : (
          <div className="space-y-3">
            {daySubmissions?.map((s) => {
              const gameLabel = gameTypes?.find((g) => g.id === s.game_type_id)?.label || "Juego";
              const author = profileMap.get(s.user_id);
              const authorName = displayName(author?.username);
              return (
                <article key={s.id} className="rounded-xl border border-slate-200 bg-white p-3">
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
                    <span>{gameLabel}</span>
                  </div>
                  <div className="font-mono text-sm leading-5">
                    {(s.grid_rows as string[]).map((line: string, i: number) => (
                      <p key={i}>{line}</p>
                    ))}
                  </div>
                  <p className="mt-2 text-sm font-medium">Intentos: {s.attempts}</p>
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
