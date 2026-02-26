"use client";

import { useEffect, useState } from "react";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authorized, setAuthorized] = useState<boolean | null>(null);

  useEffect(() => {
    // Check URL for ?auth= param
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("auth");

    if (urlToken) {
      localStorage.setItem("clawui_token", urlToken);
      // Strip auth param from URL to prevent leakage
      params.delete("auth");
      const cleanSearch = params.toString();
      const cleanUrl = window.location.pathname + (cleanSearch ? `?${cleanSearch}` : "");
      history.replaceState(null, "", cleanUrl);
      setAuthorized(true);
      return;
    }

    // Check localStorage
    const storedToken = localStorage.getItem("clawui_token");
    setAuthorized(!!storedToken);
  }, []);

  // Loading state (first render before useEffect runs)
  if (authorized === null) {
    return <div className="min-h-screen bg-bg-primary" />;
  }

  if (!authorized) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-primary">
        <div className="max-w-md rounded-lg border border-border-primary bg-bg-secondary p-8 text-center">
          <div className="mb-4 text-4xl">&#128274;</div>
          <h1 className="mb-2 text-xl font-bold text-text-primary">Unauthorized</h1>
          <p className="text-text-secondary">
            Please open the secure link printed in the ClawUI terminal to access this dashboard.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
