"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import "./globals.css";

const navItems = [
  { href: "/", label: "Sessions" },
  { href: "/blueprints", label: "Blueprints" },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <html lang="en" className="dark">
      <head>
        <title>ClawUI — Claude Code Session Viewer</title>
        <meta name="description" content="Visualize and interact with Claude Code sessions" />
      </head>
      <body className="min-h-screen bg-bg-primary text-text-primary antialiased">
        <header className="sticky top-0 z-50 border-b border-border-primary bg-bg-primary/80 backdrop-blur-sm">
          <div className="mx-auto max-w-5xl px-4 py-3 flex items-center gap-3">
            <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <span className="text-xl">🐾</span>
              <span className="font-semibold text-lg">ClawUI</span>
            </Link>
            <nav className="flex items-center gap-1 ml-4">
              {navItems.map((item) => {
                const isActive =
                  item.href === "/"
                    ? pathname === "/" || pathname.startsWith("/session")
                    : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      isActive
                        ? "bg-bg-tertiary text-text-primary font-medium"
                        : "text-text-muted hover:text-text-secondary hover:bg-bg-secondary"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
