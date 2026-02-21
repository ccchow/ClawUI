import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClawUI — Claude Code Session Viewer",
  description: "Visualize and interact with Claude Code sessions",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-bg-primary text-text-primary antialiased">
        <header className="sticky top-0 z-50 border-b border-border-primary bg-bg-primary/80 backdrop-blur-sm">
          <div className="mx-auto max-w-5xl px-4 py-3 flex items-center gap-3">
            <a href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <span className="text-xl">🐾</span>
              <span className="font-semibold text-lg">ClawUI</span>
            </a>
            <span className="text-text-muted text-sm">Session Viewer</span>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
