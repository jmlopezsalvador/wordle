import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function LoginPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (user) redirect("/groups");

  const signIn = async () => {
    "use server";
    const supabaseServer = await createSupabaseServerClient();
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const { data, error } = await supabaseServer.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${appUrl}/auth/callback` }
    });
    if (error || !data.url) throw new Error(error?.message || "No se pudo iniciar sesion");
    redirect(data.url as never);
  };

  return (
    <section className="space-y-5">
      <div className="panel space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-sky-600">Wordle Friends</p>
        <h1 className="title-xl">Accede con Google</h1>
        <p className="muted">Login rapido para crear grupos, registrar partidas y comparar ranking diario.</p>
      </div>
      <form action={signIn} className="panel">
        <button className="button-primary w-full" type="submit">
          Continuar con Google
        </button>
      </form>
    </section>
  );
}
