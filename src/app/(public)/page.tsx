import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function HomePage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  const entryHref = user ? "/groups" : "/login";

  return (
    <section className="space-y-5">
      <div className="panel">
        <h1 className="title-xl text-center text-sky-600">WORDLE FRIENDS</h1>
      </div>
      <div>
        <Link className="button-primary w-full" href={entryHref}>
          Entrar
        </Link>
      </div>
    </section>
  );
}
