import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wordle Friends MVP",
  description: "Track Wordle and Frase del dia scores with friends"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <main className="container-shell py-6">{children}</main>
      </body>
    </html>
  );
}
