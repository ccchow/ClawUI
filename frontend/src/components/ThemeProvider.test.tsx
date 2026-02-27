import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "./ThemeProvider";

// Track calls to useTheme hooks
let mockSetTheme: ReturnType<typeof vi.fn>;
let mockResolvedTheme: string | undefined;

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({
    setTheme: mockSetTheme,
    resolvedTheme: mockResolvedTheme,
  }),
}));

import type { Mock } from "vitest";

let mockGetAppState: Mock<(...args: unknown[]) => unknown>;
let mockUpdateAppState: Mock<(...args: unknown[]) => unknown>;

vi.mock("@/lib/api", () => ({
  getAppState: (...args: unknown[]) => mockGetAppState(...args),
  updateAppState: (...args: unknown[]) => mockUpdateAppState(...args),
}));

beforeEach(() => {
  mockSetTheme = vi.fn();
  mockResolvedTheme = "dark";
  mockGetAppState = vi.fn(() => Promise.resolve({ ui: { theme: "dark" } }));
  mockUpdateAppState = vi.fn(() => Promise.resolve());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ThemeProvider", () => {
  it("renders children", () => {
    render(
      <ThemeProvider>
        <div>Test content</div>
      </ThemeProvider>,
    );
    expect(screen.getByText("Test content")).toBeInTheDocument();
  });

  it("fetches app state on mount to sync theme", async () => {
    mockGetAppState.mockResolvedValueOnce({ ui: { theme: "light" } });

    render(
      <ThemeProvider>
        <div>Content</div>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(mockGetAppState).toHaveBeenCalled();
    });
  });

  it("sets theme from backend app state", async () => {
    mockGetAppState.mockResolvedValueOnce({ ui: { theme: "light" } });

    render(
      <ThemeProvider>
        <div>Content</div>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(mockSetTheme).toHaveBeenCalledWith("light");
    });
  });

  it("handles getAppState failure gracefully", async () => {
    mockGetAppState.mockRejectedValueOnce(new Error("Network error"));

    render(
      <ThemeProvider>
        <div>Content</div>
      </ThemeProvider>,
    );

    // Should still render without errors
    expect(screen.getByText("Content")).toBeInTheDocument();
  });

  it("accepts valid theme values from backend", async () => {
    for (const theme of ["dark", "light", "system"]) {
      mockGetAppState.mockResolvedValueOnce({ ui: { theme } });
      mockSetTheme.mockClear();

      const { unmount } = render(
        <ThemeProvider>
          <div>Content</div>
        </ThemeProvider>,
      );

      await waitFor(() => {
        expect(mockSetTheme).toHaveBeenCalledWith(theme);
      });

      unmount();
    }
  });

  it("does not set theme when backend returns no theme", async () => {
    mockGetAppState.mockResolvedValueOnce({});

    render(
      <ThemeProvider>
        <div>Content</div>
      </ThemeProvider>,
    );

    // Wait for the async call to complete
    await waitFor(() => {
      expect(mockGetAppState).toHaveBeenCalled();
    });

    // setTheme should not have been called with undefined
    expect(mockSetTheme).not.toHaveBeenCalled();
  });

  it("does not set theme for invalid theme values", async () => {
    mockGetAppState.mockResolvedValueOnce({ ui: { theme: "invalid-theme" } });

    render(
      <ThemeProvider>
        <div>Content</div>
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(mockGetAppState).toHaveBeenCalled();
    });

    // Only valid values (dark, light, system) should trigger setTheme
    expect(mockSetTheme).not.toHaveBeenCalled();
  });
});
