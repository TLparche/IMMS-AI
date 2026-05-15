import type { Metadata } from "next";
import { Inter, Noto_Sans_KR } from "next/font/google";
import type { CSSProperties, ReactNode } from "react";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";

export const metadata: Metadata = {
  title: "IMMS Meeting AI Assistant",
  description: "AI meeting workspace for live transcription, agenda analysis, shared canvas, and personal notes.",
};

export const dynamic = "force-dynamic";

interface RootLayoutProps {
  children: ReactNode;
}

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const notoSansKr = Noto_Sans_KR({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-noto-sans-kr",
  weight: "variable",
});

const fontVariables = {
  "--font-body": "var(--font-inter), var(--font-noto-sans-kr), sans-serif",
  "--font-display": "var(--font-inter), var(--font-noto-sans-kr), sans-serif",
} as CSSProperties;

export default function RootLayout({ children }: Readonly<RootLayoutProps>) {
  return (
    <html lang="ko">
      <body className={`${inter.variable} ${notoSansKr.variable}`} style={fontVariables}>
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
