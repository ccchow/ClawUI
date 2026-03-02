import type { Metadata } from "next";
import { NavBar } from "@/components/NavBar";
import { AuthProvider } from "@/components/AuthProvider";
import { ThemeProvider } from "@/components/ThemeProvider";
import { ToastProvider } from "@/components/Toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "ClawUI — Agent Session Viewer",
  description: "Visualize and interact with agent sessions",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-bg-primary text-text-primary antialiased">
        <AuthProvider>
          <ThemeProvider>
            <ToastProvider>
              <NavBar />
              <main className="mx-auto max-w-5xl px-3 sm:px-4 py-6 overflow-x-hidden">{children}</main>
            </ToastProvider>
          </ThemeProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
