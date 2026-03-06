import Link from "next/link";
import { redirect } from "next/navigation";
import { generateGroupCode } from "@/lib/groups";
import { addDaysToIsoDay, getActiveDayISO } from "@/lib/active-day";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SubmitOnceButton } from "@/components/ui/submit-once-button";

function initials(email: string | null | undefined) {
  const raw = email?.split("@")[0] || "U";
  return raw.slice(0, 2).toUpperCase();
}

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

export default async function GroupsPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string; tg_link?: string; tg_notice?: string }>;
}) {
  const { error, tg_link: tgLink, tg_notice: tgNotice } = await searchParams;
  const { supabase, user } = await requireUser();

  const signOut = async () => {
    "use server";
    const supabaseServer = await createSupabaseServerClient();
    await supabaseServer.auth.signOut();
    redirect("/login");
  };

  const createGroup = async (formData: FormData) => {
    "use server";
    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");

    const name = String(formData.get("name") || "").trim();
    if (!name) throw new Error("El nombre del grupo es obligatorio");

    const code = generateGroupCode();
    const { data: groupId, error: createError } = await supabaseServer.rpc("create_group", { p_name: name, p_code: code });
    if (createError || !groupId) {
      throw new Error(`Create group failed | code=${createError?.code ?? "unknown"} | message=${createError?.message ?? "error"}`);
    }

    const iconUrl = String(formData.get("icon_url") || "").trim();
    if (iconUrl) {
      await supabaseServer.from("groups").update({ icon_url: iconUrl }).eq("id", groupId).eq("owner_id", currentUser.id);
    }

    redirect(`/groups/${groupId}`);
  };

  const joinGroup = async (formData: FormData) => {
    "use server";
    const code = String(formData.get("code") || "")
      .trim()
      .toUpperCase();
    if (!code) {
      redirect("/groups?error=missing_code");
    }

    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");

    const { data: groupId, error: joinError } = await supabaseServer.rpc("join_group_by_code", { p_code: code });
    if (joinError) {
      redirect("/groups?error=join_failed");
    }
    if (!groupId) {
      redirect("/groups?error=invalid_code");
    }
    redirect(`/groups/${groupId}`);
  };

  const createTelegramLinkToken = async () => {
    "use server";
    const supabaseServer = await createSupabaseServerClient();
    const {
      data: { user: currentUser }
    } = await supabaseServer.auth.getUser();
    if (!currentUser) redirect("/login");

    const username = currentUser.email?.split("@")[0] || "usuario";
    await supabaseServer.from("profiles").upsert(
      {
        id: currentUser.id,
        username,
        avatar_url: (currentUser.user_metadata?.avatar_url as string | undefined) || null
      },
      { onConflict: "id" }
    );

    const token = crypto.randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await supabaseServer.from("telegram_link_tokens").insert({
      token,
      app_user_id: currentUser.id,
      expires_at: expiresAt
    });

    redirect(`/groups?tg_link=${token}`);
  };

  const [{ data: myProfile }, { data: memberships }, { data: mySubmissions }] = await Promise.all([
    supabase.from("profiles").select("id,username").eq("id", user.id).maybeSingle(),
    supabase.from("group_members").select("group_id, groups(id,name,code,icon_url)").eq("user_id", user.id),
    supabase.from("submissions").select("played_on,attempts").eq("user_id", user.id).order("played_on", { ascending: true })
  ]);

  const userName = myProfile?.username || user.email?.split("@")[0] || "Usuario";
  const avatarUrl = (user.user_metadata?.avatar_url as string | undefined) ?? null;
  const groups = (memberships || [])
    .map((row) => (Array.isArray(row.groups) ? row.groups[0] : row.groups))
    .filter(Boolean) as Array<{ id: string; name: string; code: string; icon_url: string | null }>;
  const groupIds = groups.map((g) => g.id);

  const alertMessage =
    error === "invalid_code"
      ? "Ese codigo de grupo no existe."
      : error === "join_failed"
        ? "No se pudo unir al grupo. Intentalo de nuevo."
        : error === "missing_code"
          ? "Introduce un codigo para unirte."
          : null;

  const groupPositions = new Map<string, number>();
  if (groupIds.length > 0) {
    const [{ data: groupSubs }, { data: gm }] = await Promise.all([
      supabase.from("submissions").select("group_id,user_id,attempts").in("group_id", groupIds),
      supabase.from("group_members").select("group_id,user_id").in("group_id", groupIds)
    ]);

    for (const groupId of groupIds) {
      const memberIds = (gm || []).filter((x) => x.group_id === groupId).map((x) => x.user_id);
      const totals = new Map<string, number>(memberIds.map((id) => [id, 0]));
      for (const row of groupSubs || []) {
        if (row.group_id !== groupId) continue;
        totals.set(row.user_id, (totals.get(row.user_id) || 0) + row.attempts);
      }
      const rank = [...totals.entries()].sort((a, b) => a[1] - b[1]).map((x) => x[0]);
      const pos = rank.findIndex((id) => id === user.id);
      groupPositions.set(groupId, pos >= 0 ? pos + 1 : memberIds.length);
    }
  }

  const activeDay = getActiveDayISO();
  const start = addDaysToIsoDay(activeDay, -29);
  const dailyMap = new Map<string, number>();
  for (let i = 0; i < 30; i += 1) dailyMap.set(addDaysToIsoDay(start, i), 0);
  for (const row of mySubmissions || []) {
    if (row.played_on >= start && row.played_on <= activeDay) {
      dailyMap.set(row.played_on, (dailyMap.get(row.played_on) || 0) + row.attempts);
    }
  }
  const chartData = [...dailyMap.entries()].map(([day, value]) => ({ day, value }));
  const chartMax = Math.max(1, ...chartData.map((d) => d.value));
  const totalResults = mySubmissions?.length || 0;

  return (
    <section className="space-y-4">
      <div className="panel">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatarUrl} alt="Avatar" className="avatar object-cover" />
            ) : (
              <div className="avatar">{initials(user.email)}</div>
            )}
            <div>
              <h1 className="text-lg font-semibold">{userName}</h1>
              <p className="text-xs text-slate-500">{user.email}</p>
            </div>
          </div>
          <form action={signOut}>
            <SubmitOnceButton className="button-secondary h-10 rounded-full px-4" pendingText="Saliendo...">
              Salir
            </SubmitOnceButton>
          </form>
        </div>
      </div>

      {alertMessage ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{alertMessage}</div>
      ) : null}
      {tgNotice === "expired" ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          El token de Telegram expiro. Genera uno nuevo.
        </div>
      ) : null}
      {tgLink ? (
        <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
          Token Telegram generado (15 min): <span className="font-mono font-semibold">{tgLink}</span>. En Telegram:{" "}
          <span className="font-mono">/link {tgLink}</span>
        </div>
      ) : null}

      <div className="panel space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Resultados</p>
            <p className="mt-1 text-2xl font-semibold">{totalResults}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">Grupos</p>
            <p className="mt-1 text-2xl font-semibold">{groups.length}</p>
          </div>
        </div>
        <div>
          <p className="mb-2 text-sm font-semibold">Intentos (ultimos 30 dias)</p>
          <div className="flex h-28 items-end gap-1 rounded-xl border border-slate-200 bg-white p-2">
            {chartData.map((d) => {
              const h = Math.max(4, Math.round((d.value / chartMax) * 100));
              return <div key={d.day} className="w-2 rounded bg-sky-500/80" style={{ height: `${h}%` }} title={`${d.day}: ${d.value}`} />;
            })}
          </div>
        </div>
      </div>

      <div className="panel space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Tus grupos</h2>
          <span className="text-xs text-slate-500">Tu posicion en cada grupo</span>
        </div>
        <div className="space-y-2">
          {groups.map((group) => (
            <Link key={group.id} href={`/groups/${group.id}`} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex items-center gap-3">
                {group.icon_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={group.icon_url} alt="Icono grupo" className="h-10 w-10 rounded-lg object-cover" />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src="/default-group-logo.svg" alt="Icono grupo por defecto" className="h-10 w-10 rounded-lg object-cover" />
                )}
                <div>
                  <p className="font-semibold">{group.name}</p>
                  <p className="text-xs text-slate-500">Codigo: {group.code}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-500">Posicion</p>
                <p className="text-sm font-semibold">#{groupPositions.get(group.id) || "-"}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>

      <details className="panel">
        <summary className="cursor-pointer select-none text-sm font-semibold">Acciones de grupo</summary>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <form className="space-y-3 rounded-xl border border-slate-200 bg-white p-3" action={createTelegramLinkToken}>
            <h3 className="text-sm font-semibold">Telegram bot</h3>
            <p className="text-xs text-slate-600">
              Genera un token temporal para vincular tu cuenta con el bot. Luego usa /link en Telegram.
            </p>
            <SubmitOnceButton className="button-secondary w-full" pendingText="Generando...">
              Generar token de enlace
            </SubmitOnceButton>
          </form>
          <form className="space-y-3 rounded-xl border border-slate-200 bg-white p-3" action={createGroup}>
            <h3 className="text-sm font-semibold">Crear grupo</h3>
            <input className="input" name="name" placeholder="Nombre del grupo" required />
            <input className="input" name="icon_url" placeholder="URL icono (opcional)" />
            <SubmitOnceButton className="button-primary w-full" pendingText="Creando...">
              Crear
            </SubmitOnceButton>
          </form>
          <form className="space-y-3 rounded-xl border border-slate-200 bg-white p-3" action={joinGroup}>
            <h3 className="text-sm font-semibold">Unirme por codigo</h3>
            <input className="input uppercase" name="code" placeholder="ABC123" required />
            <SubmitOnceButton className="button-secondary w-full" pendingText="Uniendo...">
              Unirme
            </SubmitOnceButton>
          </form>
        </div>
      </details>
    </section>
  );
}
