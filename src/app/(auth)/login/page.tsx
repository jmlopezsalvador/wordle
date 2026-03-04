import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SubmitOnceButton } from "@/components/ui/submit-once-button";

export default async function LoginPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (user) redirect("/groups");

  const signIn = async () => {
    "use server";
    const supabaseServer = await createSupabaseServerClient();
    const h = await headers();
    const proto = h.get("x-forwarded-proto") || "http";
    const host = h.get("x-forwarded-host") || h.get("host");
    const appUrl = host ? `${proto}://${host}` : process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
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
        <h1 className="title-xl">Accede con Google</h1>
        <p className="muted">Login rapido para crear grupos, registrar partidas y comparar ranking diario.</p>
      </div>
      <form action={signIn} className="panel">
        <SubmitOnceButton className="button-primary w-full" pendingText="Abriendo Google...">
          Continuar con Google
        </SubmitOnceButton>
      </form>
    </section>
  );
}
