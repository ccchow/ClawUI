import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionList } from "./SessionList";
import type { SessionMeta } from "@/lib/api";

// Mock next/link
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

// Mock API
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<object>("@/lib/api");
  return {
    ...actual,
    getTags: vi.fn(() => Promise.resolve(["bug", "feature"])),
    updateSessionMeta: vi.fn(() => Promise.resolve()),
  };
});

// Mock format-time
vi.mock("@/lib/format-time", () => ({
  formatTimeAgo: vi.fn((ts: string) => "5m ago"),
}));

function makeMockSession(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: "session-1",
    projectId: "proj-1",
    projectName: "Test Project",
    timestamp: "2025-01-15T12:00:00Z",
    nodeCount: 10,
    slug: "test-session",
    cwd: "/tmp/project",
    starred: false,
    tags: [],
    ...overrides,
  };
}

describe("SessionList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders list of sessions", () => {
    const sessions = [
      makeMockSession({ sessionId: "s1", slug: "session-one" }),
      makeMockSession({ sessionId: "s2", slug: "session-two" }),
    ];
    render(<SessionList sessions={sessions} />);
    expect(screen.getByText("session-one")).toBeInTheDocument();
    expect(screen.getByText("session-two")).toBeInTheDocument();
  });

  it("renders session ID prefix", () => {
    render(<SessionList sessions={[makeMockSession({ sessionId: "abcdefgh-1234" })]} />);
    expect(screen.getByText("abcdefgh")).toBeInTheDocument();
  });

  it("renders session cwd", () => {
    render(<SessionList sessions={[makeMockSession({ cwd: "/home/user/project" })]} />);
    expect(screen.getByText("/home/user/project")).toBeInTheDocument();
  });

  it("renders node count as messages", () => {
    render(<SessionList sessions={[makeMockSession({ nodeCount: 42 })]} />);
    expect(screen.getByText("42 messages")).toBeInTheDocument();
  });

  it("renders time ago", () => {
    render(<SessionList sessions={[makeMockSession()]} />);
    expect(screen.getByText("5m ago")).toBeInTheDocument();
  });

  it("shows empty state when no sessions", () => {
    render(<SessionList sessions={[]} />);
    expect(screen.getByText("No sessions found for this project")).toBeInTheDocument();
  });

  it("shows filter empty state when filtering", () => {
    render(<SessionList sessions={[makeMockSession()]} />);
    const searchInput = screen.getByPlaceholderText(/search/i);
    fireEvent.change(searchInput, { target: { value: "nonexistent" } });
    expect(screen.getByText("No sessions matching current filters")).toBeInTheDocument();
  });

  it("filters sessions by search query", () => {
    const sessions = [
      makeMockSession({ sessionId: "s1", slug: "auth-session" }),
      makeMockSession({ sessionId: "s2", slug: "database-session" }),
    ];
    render(<SessionList sessions={sessions} />);

    const searchInput = screen.getByPlaceholderText(/search/i);
    fireEvent.change(searchInput, { target: { value: "auth" } });

    expect(screen.getByText("auth-session")).toBeInTheDocument();
    expect(screen.queryByText("database-session")).not.toBeInTheDocument();
  });

  it("shows results count when filtering", () => {
    const sessions = [
      makeMockSession({ sessionId: "s1", slug: "auth-session" }),
      makeMockSession({ sessionId: "s2", slug: "database-session" }),
    ];
    render(<SessionList sessions={sessions} />);

    const searchInput = screen.getByPlaceholderText(/search/i);
    fireEvent.change(searchInput, { target: { value: "auth" } });

    expect(screen.getByText(/1 of 2 sessions/)).toBeInTheDocument();
  });

  it("toggles sort mode between newest and most messages", () => {
    const sessions = [
      makeMockSession({ sessionId: "s1", nodeCount: 5, timestamp: "2025-01-15T12:00:00Z" }),
      makeMockSession({ sessionId: "s2", nodeCount: 50, timestamp: "2025-01-14T12:00:00Z" }),
    ];
    render(<SessionList sessions={sessions} />);

    const sortBtn = screen.getByText(/Newest/);
    fireEvent.click(sortBtn);

    expect(screen.getByText(/Most msgs/)).toBeInTheDocument();
  });

  it("renders star button for each session", () => {
    render(<SessionList sessions={[makeMockSession()]} />);
    const starBtn = screen.getByTitle("Star");
    expect(starBtn).toBeInTheDocument();
  });

  it("shows filled star for starred session", () => {
    render(<SessionList sessions={[makeMockSession({ starred: true })]} />);
    expect(screen.getByTitle("Unstar")).toBeInTheDocument();
  });

  it("toggles star on click", async () => {
    const { updateSessionMeta } = await import("@/lib/api");
    render(<SessionList sessions={[makeMockSession({ sessionId: "s1" })]} />);

    const starBtn = screen.getByTitle("Star");
    fireEvent.click(starBtn);

    await waitFor(() => {
      expect(updateSessionMeta).toHaveBeenCalledWith("s1", { starred: true });
    });
  });

  it("renders starred filter button", () => {
    render(<SessionList sessions={[makeMockSession()]} />);
    expect(screen.getByText(/Starred/)).toBeInTheDocument();
  });

  it("renders archived filter button", () => {
    render(<SessionList sessions={[makeMockSession()]} />);
    expect(screen.getByText(/Archived/)).toBeInTheDocument();
  });

  it("hides archived sessions by default", () => {
    const sessions = [
      makeMockSession({ sessionId: "s1", slug: "active", archived: false }),
      makeMockSession({ sessionId: "s2", slug: "old-session", archived: true }),
    ];
    render(<SessionList sessions={sessions} />);
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.queryByText("old-session")).not.toBeInTheDocument();
  });

  it("shows Clear filters button when filters are active", () => {
    render(<SessionList sessions={[makeMockSession()]} />);

    const starredBtn = screen.getByText(/Starred/);
    fireEvent.click(starredBtn);

    expect(screen.getByText("Clear filters")).toBeInTheDocument();
  });

  it("clears all filters on Clear filters click", () => {
    render(<SessionList sessions={[makeMockSession({ starred: true })]} />);

    const starredBtn = screen.getByText(/Starred/);
    fireEvent.click(starredBtn);
    expect(screen.getByText("Clear filters")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Clear filters"));
    expect(screen.queryByText("Clear filters")).not.toBeInTheDocument();
  });

  it("renders session links with correct href", () => {
    render(<SessionList sessions={[makeMockSession({ sessionId: "my-session-123" })]} />);
    const link = screen.getByText("test-session").closest("a");
    expect(link?.getAttribute("href")).toBe("/session/my-session-123");
  });

  it("renders tags on sessions", () => {
    const { container } = render(
      <SessionList sessions={[makeMockSession({ tags: ["bug", "critical"] })]} />,
    );
    // Tags have hidden sm:flex class but are still in DOM
    const tagElements = container.querySelectorAll("[class*='rounded-full']");
    const tagTexts = Array.from(tagElements).map((el) => el.textContent);
    expect(tagTexts).toContain("bug");
    expect(tagTexts).toContain("critical");
  });

  it("renders alias when present", () => {
    render(
      <SessionList sessions={[makeMockSession({ alias: "My Important Session" })]} />,
    );
    expect(screen.getByText("My Important Session")).toBeInTheDocument();
  });

  it("calls onFiltersChange when filters change", async () => {
    const onFiltersChange = vi.fn();
    render(<SessionList sessions={[makeMockSession()]} onFiltersChange={onFiltersChange} />);

    // onFiltersChange should have been called on mount
    await waitFor(() => {
      expect(onFiltersChange).toHaveBeenCalled();
    });
  });
});
