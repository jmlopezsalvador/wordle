import Image from "next/image";

export function BrandHeader() {
  return (
    <header className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-100">
      <div className="relative h-28 w-full sm:h-36">
        <Image src="/brand-header.png" alt="Wordle Friends" fill className="object-cover" priority />
        <div className="absolute inset-0 bg-slate-900/35" />
        <div className="absolute inset-0 flex items-center gap-3 px-4">
          <div className="relative h-10 w-10 overflow-hidden rounded-xl border border-white/70 bg-white/95 sm:h-12 sm:w-12">
            <Image src="/logo-mark.png" alt="Logo Wordle Friends" fill className="object-cover" priority />
          </div>
          <p className="text-sm font-extrabold uppercase tracking-[0.15em] text-white sm:text-base">Wordle Friends</p>
        </div>
      </div>
    </header>
  );
}
