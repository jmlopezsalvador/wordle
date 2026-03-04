import Link from "next/link";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SubmitOnceButton } from "@/components/ui/submit-once-button";

export default async function SubmitPage({
  searchParams
}: {
  searchParams: Promise<{ groupId?: string }>;
}) {
  const { groupId } = await searchParams;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");
  if (!groupId) redirect("/groups");

  const { data: group } = await supabase.from("groups").select("id,name,entry_mode").eq("id", groupId).maybeSingle();
  const today = new Date().toISOString().slice(0, 10);
  const isHistoryMode = group?.entry_mode === "history";

  return (
    <section className="space-y-4">
      <div className="panel space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="title-xl">Registrar resultado</h1>
            <p className="muted">{group?.name || "Grupo"}</p>
          </div>
          <Link className="button-ghost h-10 rounded-full px-3" href={`/groups/${groupId}`}>
            Cancelar
          </Link>
        </div>
      </div>

      <form className="panel space-y-3" action="/api/submit" method="post">
        <input type="hidden" name="groupId" value={groupId} />
        {isHistoryMode ? (
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="playedOn">
              Fecha del resultado
            </label>
            <input id="playedOn" className="input" type="date" name="playedOn" max={today} defaultValue={today} required />
          </div>
        ) : null}
        <textarea
          className="min-h-44 w-full rounded-xl border border-slate-300 p-3 text-sm outline-none focus:border-sky-500"
          name="shareText"
          placeholder={"Wordle 1324 4/6\n⬛⬛🟨⬛⬛\n⬛🟨🟨⬛⬛\n🟩🟩🟩🟩🟩"}
          required
        />
        <div className="grid grid-cols-2 gap-3">
          <Link className="button-secondary w-full" href={`/groups/${groupId}`}>
            Volver
          </Link>
          <SubmitOnceButton className="button-primary w-full" pendingText="Guardando...">
            Guardar
          </SubmitOnceButton>
        </div>
      </form>
    </section>
  );
}
