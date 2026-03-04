import type { Metadata } from "next";
import { BrandHeader } from "@/components/brand-header";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wordle Score!",
  description: "Track Wordle and Frase del dia scores with friends"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <div className="container-shell pt-6">
          <BrandHeader />
        </div>
        <main className="container-shell py-6">{children}</main>
        <footer className="pb-6 text-center text-xs text-slate-500">Wordle Score 2026 Developed By @WikiCode</footer>
      </body>
    </html>
  );
}