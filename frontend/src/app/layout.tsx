import type { Metadata } from "next";
import "./globals.css";
import { WorkNavigation } from '../features/workbench';

export const metadata: Metadata = {
  title: "接案助理 · Freelance Agent",
  description: "整理值得投入的機會，讓每封提案都有根據。",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-Hant"><body><WorkNavigation/>{children}</body></html>;
}
