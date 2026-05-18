import type { Metadata } from "next";
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

const fontVariables = {
  "--font-body": '"Inter", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", sans-serif',
  "--font-display": '"Inter", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", sans-serif',
  "--font-inter": '"Inter", "Segoe UI", sans-serif',
  "--font-noto-sans-kr": '"Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
} as CSSProperties;

export default function RootLayout({ children }: Readonly<RootLayoutProps>) {
  return (
    <html lang="ko">
      <body style={fontVariables}>
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
