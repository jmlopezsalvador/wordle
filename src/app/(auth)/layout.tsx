import { BrandHeader } from "@/components/brand-header";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <section className="space-y-5">
      <BrandHeader />
      {children}
    </section>
  );
}
