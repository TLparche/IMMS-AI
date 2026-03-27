import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import "./globals.css";
import { AuthProvider } from "@/contexts/AuthContext";

export const metadata: Metadata = {
  title: "Meeting Workspace",
  description: "Meeting workspace dashboard with agenda-aware transcript and summaries.",
};

interface RootLayoutProps {
  children: ReactNode;
}

const fontVariables = {
  "--font-body": '"Segoe UI", "Noto Sans KR", sans-serif',
  "--font-display": '"Segoe UI", "Noto Sans KR", sans-serif',
} as CSSProperties;

export default function RootLayout({ children }: Readonly<RootLayoutProps>) {
  return (
    <html lang="en">
      <body style={fontVariables}>
        <AuthProvider>
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
