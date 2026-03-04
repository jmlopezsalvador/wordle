import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  const entryHref = user ? "/groups" : "/login";

  return (
    <section>
      <div className="panel">
        <Link className="button-primary w-full" href={entryHref}>
          Entrar
        </Link>
      </div>
    </section>
  );
}
