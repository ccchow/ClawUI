import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AuthProvider } from "./AuthProvider";

let mockStorage: Record<string, string> = {};

beforeEach(() => {
  mockStorage = {};
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => mockStorage[key] ?? null),
    setItem: vi.fn((key: string, val: string) => { mockStorage[key] = val; }),
    removeItem: vi.fn((key: string) => { delete mockStorage[key]; }),
  });

  // Mock window.location and history
  Object.defineProperty(window, "location", {
    value: { search: "", pathname: "/", href: "http://localhost:3000/", hostname: "localhost" },
    writable: true,
    configurable: true,
  });
  vi.stubGlobal("history", { replaceState: vi.fn() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AuthProvider", () => {
  it("shows children when token is in localStorage", () => {
    mockStorage["clawui_token"] = "abc123";
    render(<AuthProvider><div>Dashboard</div></AuthProvider>);
    expect(screen.getByText("Dashboard")).toBeTruthy();
  });

  it("shows unauthorized message when no token exists", () => {
    render(<AuthProvider><div>Dashboard</div></AuthProvider>);
    expect(screen.queryByText("Dashboard")).toBeNull();
    expect(screen.getByText(/Unauthorized/i)).toBeTruthy();
  });

  it("extracts token from ?auth= param and stores it", () => {
    window.location.search = "?auth=mytoken123";
    render(<AuthProvider><div>Dashboard</div></AuthProvider>);
    expect(localStorage.setItem).toHaveBeenCalledWith("clawui_token", "mytoken123");
    expect(history.replaceState).toHaveBeenCalled();
    expect(screen.getByText("Dashboard")).toBeTruthy();
  });
});
