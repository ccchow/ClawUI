"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { redeployStable, getDevStatus } from "@/lib/api";

const navItems = [
  { href: "/blueprints", label: "Blueprints" },
  { href: "/", label: "Sessions" },
];

export function NavBar() {
  const pathname = usePathname();

  // Dev mode redeploy
  const [redeploying, setRedeploying] = useState(false);
  const [isDevMode, setIsDevMode] = useState(false);
  useEffect(() => {
    // Port-based detection (dev port !== 3000)
    if (typeof window !== "undefined") {
      const devPort = window.location.port !== "3000" && window.location.port !== "";
      if (devPort) {
        setIsDevMode(true);
        return;
      }
    }
    // Backend CLAWUI_DEV env var detection
    getDevStatus().then(({ devMode }) => {
      if (devMode) setIsDevMode(true);
    }).catch(() => { /* ignore */ });
  }, []);

  return (
    <header className="sticky top-0 z-50 border-b border-border-primary bg-bg-primary/80 backdrop-blur-sm">
      <div className="mx-auto max-w-5xl px-3 sm:px-4 py-3 flex items-center gap-2 sm:gap-3 flex-wrap">
        <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <span className="text-xl">🐾</span>
          <span className="font-semibold text-lg hidden sm:inline">ClawUI</span>
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
        {isDevMode && (
          <button
            onClick={async () => {
              setRedeploying(true);
              try {
                await redeployStable();
              } catch {
                // non-critical
              } finally {
                setRedeploying(false);
              }
            }}
            disabled={redeploying}
            className="ml-auto flex-shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed bg-amber-600/20 text-amber-400 hover:bg-amber-600/30 border border-amber-600/30"
            title="Redeploy & restart stable environment"
          >
            {redeploying ? (
              <span className="flex items-center gap-1">
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" /></svg>
                Deploying...
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>
                Redeploy
              </span>
            )}
          </button>
        )}
      </div>
    </header>
  );
}
