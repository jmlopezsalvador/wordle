import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CommentItem } from "@/components/groups/comment-item";

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

  const [
    { data: group },
    { data: allSubmissions },
    { data: daySubmissions },
    { data: members },
    { data: profiles },
    { data: gameTypes },
    { data: dayComments }
  ] = await Promise.all([
    supabase.from("groups").select("id,name,code,icon_url,owner_id,entry_mode").eq("id", groupId).single(),
    supabase.from("submissions").select("user_id,attempts,played_on").eq("group_id", groupId).lte("played_on", selectedDate),
    supabase
      .from("submissions")
      .select("id,user_id,attempts,grid_rows,game_type_id,played_on,created_at")
      .eq("group_id", groupId)
      .eq("played_on", selectedDate)
      .order("created_at", { ascending: false }),
    supabase.from("group_members").select("user_id,role,joined_at").eq("group_id", groupId),
    supabase.from("profiles").select("id,username,avatar_url"),
    supabase.from("game_types").select("id,label"),
    supabase
      .from("group_comments")
      .select("id,user_id,body,created_at")
      .eq("group_id", groupId)
      .eq("comment_date", selectedDate)
      .order("created_at", { ascending: false })
  ]);

  if (!group) notFound();
  const isOwner = membership.role === "owner" || group.owner_id === user.id;

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

  const forceRecalc = async () => {
    "use server";
    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");
    await supabaseServer.rpc("recalc_group_scores", { p_group_id: groupId, p_through: ymd(new Date()) });
    redirect(`/groups/${groupId}?date=${selectedDate}&notice=recalculated`);
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

  const addComment = async (formData: FormData) => {
    "use server";
    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");

    const body = String(formData.get("body") || "").trim();
    if (!body) redirect(`/groups/${groupId}?date=${selectedDate}&notice=comment_empty`);
    if (body.length > 280) redirect(`/groups/${groupId}?date=${selectedDate}&notice=comment_too_long`);

    await supabaseServer.from("group_comments").insert({
      group_id: groupId,
      user_id: currentUser.id,
      comment_date: selectedDate,
      body
    });

    redirect(`/groups/${groupId}?date=${selectedDate}&notice=comment_added`);
  };

  const profileMap = new Map((profiles || []).map((p) => [p.id, p]));
  const attemptsByUserDay = new Map<string, number>();
  for (const item of allSubmissions || []) {
    const key = `${item.user_id}:${item.played_on}`;
    attemptsByUserDay.set(key, (attemptsByUserDay.get(key) || 0) + item.attempts);
  }

  const rankingData: Array<{ userId: string; score: number; name: string; avatar: string | null; role: string }> = [];
  for (const member of members || []) {
    const joinedOn = ymd(new Date(member.joined_at));
    let total = 0;
    if (joinedOn <= selectedDate) {
      for (const day of dateRange(joinedOn, selectedDate)) {
        const dayAttempts = attemptsByUserDay.get(`${member.user_id}:${day}`) || 0;
        total += dayAttempts > 0 ? dayAttempts : 2;
      }
    }
    rankingData.push({
      userId: member.user_id,
      score: total,
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
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-200 text-xs font-semibold text-slate-700">
                {initials(group.name)}
              </div>
            )}
            <div>
              <h1 className="title-xl">{group.name}</h1>
              <p className="muted">
                Codigo: {group.code} · Modo: {group.entry_mode === "history" ? "historial" : "diario"}
              </p>
            </div>
          </div>
          <Link className="button-ghost h-10 rounded-full px-3" href="/groups">
            Menu
          </Link>
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
              <button className="button-secondary w-full" type="submit">
                Guardar cambios
              </button>
            </form>
            <form action={forceRecalc} className="mt-3">
              <button className="button-secondary w-full" type="submit">
                Forzar actualizacion de puntuaciones
              </button>
            </form>
            <div className="mt-3 space-y-2">
              <p className="text-sm font-semibold">Miembros</p>
              {ranking.map((m) => (
                <div key={m.userId} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2">
                  <p className="text-sm">
                    {m.name} {m.role === "owner" ? "(owner)" : ""}
                  </p>
                  {m.role !== "owner" ? (
                    <form action={kickMember}>
                      <input type="hidden" name="targetUserId" value={m.userId} />
                      <button className="button-secondary h-8 px-3 text-xs" type="submit">
                        Expulsar
                      </button>
                    </form>
                  ) : null}
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>

      <div className="panel space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Clasificacion a fecha</h2>
          <p className="text-sm font-semibold">{selectedDate}</p>
        </div>
        <div className="space-y-2">
          {raceData.map((r) => (
            <div key={r.userId} className="rounded-xl border border-slate-200 bg-white p-2">
              <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                <span>{r.name}</span>
                <span>{r.score} pts</span>
              </div>
              <div className="relative h-9 rounded-lg bg-slate-100">
                <div className="absolute left-0 top-0 h-9 rounded-lg bg-sky-500/20" style={{ width: `${r.progress}%` }} />
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
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Leaderboard</h2>
        <div className="space-y-2">
          {ranking.map((r, idx) => (
            <div key={r.userId} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-3 py-2">
              <p className="text-sm">
                {idx + 1}. {r.name}
              </p>
              <p className="font-semibold">{r.score}</p>
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
          <button className="button-secondary w-full" type="submit">
            Publicar comentario
          </button>
        </form>

        {(dayComments || []).length === 0 ? (
          <p className="muted">Aun no hay comentarios en este dia.</p>
        ) : (
          <div className="space-y-2">
            {dayComments?.map((c) => {
              const author = profileMap.get(c.user_id);
              const authorName = displayName(author?.username);
              const canManage = c.user_id === user.id || isOwner;
              return (
                <CommentItem
                  key={c.id}
                  commentId={c.id}
                  body={c.body}
                  createdAt={c.created_at}
                  authorName={authorName}
                  authorAvatarUrl={author?.avatar_url ?? null}
                  canManage={canManage}
                  groupId={group.id}
                  selectedDate={selectedDate}
                />
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
