import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "Freelance Agent", robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
