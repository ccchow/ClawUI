"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import { getAppState, updateAppState } from "@/lib/api";

function ThemeSyncer({ children }: { children: React.ReactNode }) {
  const { resolvedTheme, setTheme } = useTheme();
  const mountedRef = useRef(false);
  const lastSyncedRef = useRef<string | null>(null);

  // On mount, fetch backend-persisted theme preference
  useEffect(() => {
    getAppState()
      .then((state) => {
        const ui = state?.ui as Record<string, unknown> | undefined;
        const saved = ui?.theme as string | undefined;
        if (saved && (saved === "dark" || saved === "light" || saved === "system")) {
          setTheme(saved);
        }
      })
      .catch(() => {
        // Ignore — backend may not be reachable yet
      })
      .finally(() => {
        mountedRef.current = true;
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist theme changes to backend
  useEffect(() => {
    if (!mountedRef.current || !resolvedTheme) return;
    if (lastSyncedRef.current === resolvedTheme) return;
    lastSyncedRef.current = resolvedTheme;
    updateAppState({ ui: { theme: resolvedTheme } }).catch(() => {
      // Ignore persistence failures
    });
  }, [resolvedTheme]);

  return <>{children}</>;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={true}
      storageKey="clawui-theme"
    >
      <ThemeSyncer>{children}</ThemeSyncer>
    </NextThemesProvider>
  );
}
