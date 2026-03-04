import Link from "next/link";

export default function HomePage() {
  return (
    <section className="space-y-5">
      <div className="panel space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.15em] text-sky-600">MVP</p>
        <h1 className="title-xl">Ranking Wordle con amigos</h1>
        <p className="muted">Mobile-first, grupos privados y ranking por menor puntuacion acumulada.</p>
      </div>
      <div className="grid gap-3">
        <Link className="button-primary" href="/login">
          Entrar
        </Link>
        <Link className="button-secondary" href="/groups">
          Ir a grupos
        </Link>
      </div>
    </section>
  );
}
