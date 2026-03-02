import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BlueprintsPage from "./page";
import { makeMockBlueprint } from "@/test-utils";
import type { Blueprint } from "@/lib/api";

// --- Mocks ---

// vi.hoisted runs before vi.mock hoisting, making these available in the factory
const apiMocks = vi.hoisted(() => ({
  listBlueprints: vi.fn((): Promise<Blueprint[]> => Promise.resolve([])),
  archiveBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
  unarchiveBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
  starBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
  unstarBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<object>("@/lib/api");
  return { ...actual, ...apiMocks };
});

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), back: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  usePathname: vi.fn(() => "/blueprints"),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

vi.mock("@/components/StatusIndicator", () => ({
  StatusIndicator: ({ status }: { status: string }) => <span data-testid="status-indicator">{status}</span>,
}));

vi.mock("@/components/SkeletonLoader", () => ({
  SkeletonLoader: () => <div data-testid="skeleton-loader" />,
}));

// --- Helpers ---

function makeBlueprints(): Blueprint[] {
  return [
    makeMockBlueprint({ id: "bp-1", title: "Auth System", status: "approved", nodes: [], updatedAt: "2025-01-02T00:00:00Z" }),
    makeMockBlueprint({ id: "bp-2", title: "Dashboard UI", status: "draft", nodes: [], updatedAt: "2025-01-01T00:00:00Z" }),
    makeMockBlueprint({ id: "bp-3", title: "Done BP", status: "done", nodes: [], updatedAt: "2025-01-03T00:00:00Z" }),
  ];
}

// --- Tests ---

describe("BlueprintsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Stub sessionStorage
    vi.stubGlobal("sessionStorage", { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() });
  });

  it("renders blueprint cards from listBlueprints response", async () => {
    apiMocks.listBlueprints.mockResolvedValue(makeBlueprints());

    render(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText("Auth System")).toBeInTheDocument();
    });
  });

  it("shows 'New Blueprint' link", async () => {
    apiMocks.listBlueprints.mockResolvedValue(makeBlueprints());
    render(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText("Auth System")).toBeInTheDocument();
    });

    const newLink = screen.getByText("New Blueprint");
    expect(newLink.closest("a")).toHaveAttribute("href", "/blueprints/new");
  });

  it("filters by status when clicking status chips", async () => {
    apiMocks.listBlueprints.mockResolvedValue(makeBlueprints());
    render(<BlueprintsPage />);

    // Wait for initial render with default "Approved" filter
    await waitFor(() => {
      expect(screen.getByText("Auth System")).toBeInTheDocument();
    });

    // Default filter is "Approved" — Draft BP should not be visible
    expect(screen.queryByText("Dashboard UI")).not.toBeInTheDocument();

    // Click "All" status filter to see all
    const allChip = screen.getByText("All");
    fireEvent.click(allChip);

    await waitFor(() => {
      expect(screen.getByText("Dashboard UI")).toBeInTheDocument();
    });
    expect(screen.getByText("Auth System")).toBeInTheDocument();
    expect(screen.getByText("Done BP")).toBeInTheDocument();
  });

  it("filters to show only draft blueprints", async () => {
    apiMocks.listBlueprints.mockResolvedValue(makeBlueprints());
    render(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText("Auth System")).toBeInTheDocument();
    });

    // Click "Draft" filter
    const draftChip = screen.getByRole("button", { name: /Draft/ });
    fireEvent.click(draftChip);

    await waitFor(() => {
      expect(screen.getByText("Dashboard UI")).toBeInTheDocument();
    });
    expect(screen.queryByText("Auth System")).not.toBeInTheDocument();
  });

  it("calls archiveBlueprint when archive button is clicked", async () => {
    apiMocks.listBlueprints.mockResolvedValue([
      makeMockBlueprint({ id: "bp-1", title: "My BP", status: "approved" }),
    ]);
    apiMocks.archiveBlueprint.mockResolvedValue(makeMockBlueprint({ id: "bp-1", archivedAt: "2025-01-01" }));

    render(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText("My BP")).toBeInTheDocument();
    });

    const archiveBtn = screen.getByLabelText("Archive blueprint");
    fireEvent.click(archiveBtn);

    await waitFor(() => {
      expect(apiMocks.archiveBlueprint).toHaveBeenCalledWith("bp-1");
    });
  });

  it("calls unarchiveBlueprint when unarchive button is clicked", async () => {
    apiMocks.listBlueprints.mockResolvedValue([
      makeMockBlueprint({ id: "bp-archived", title: "Archived BP", status: "done", archivedAt: "2025-01-01" }),
    ]);
    apiMocks.unarchiveBlueprint.mockResolvedValue(
      makeMockBlueprint({ id: "bp-archived", title: "Archived BP", archivedAt: undefined }),
    );

    render(<BlueprintsPage />);

    // Toggle "Show archived"
    await waitFor(() => {
      const archiveToggle = screen.getByLabelText("Show archived blueprints");
      fireEvent.click(archiveToggle);
    });

    // Filter to "All" to see the archived blueprint
    const allChip = screen.getByText("All");
    fireEvent.click(allChip);

    await waitFor(() => {
      expect(screen.getByText("Archived BP")).toBeInTheDocument();
    });

    const unarchiveBtn = screen.getByLabelText("Unarchive blueprint");
    fireEvent.click(unarchiveBtn);

    await waitFor(() => {
      expect(apiMocks.unarchiveBlueprint).toHaveBeenCalledWith("bp-archived");
    });
  });

  it("shows empty state when no blueprints exist", async () => {
    apiMocks.listBlueprints.mockResolvedValue([]);
    render(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText("No blueprints yet.")).toBeInTheDocument();
    });
  });

  it("shows error message when API fails", async () => {
    apiMocks.listBlueprints.mockRejectedValue(new Error("Network error"));
    render(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load blueprints/)).toBeInTheDocument();
      expect(screen.getByText(/Network error/)).toBeInTheDocument();
    });
  });

  it("shows node count for each blueprint", async () => {
    apiMocks.listBlueprints.mockResolvedValue([
      makeMockBlueprint({ id: "bp-1", title: "Multi Node BP", status: "approved", nodes: [
        { id: "n1", blueprintId: "bp-1", order: 0, seq: 1, title: "N1", description: "", status: "pending", dependencies: [], inputArtifacts: [], outputArtifacts: [], executions: [], createdAt: "", updatedAt: "" },
        { id: "n2", blueprintId: "bp-1", order: 1, seq: 2, title: "N2", description: "", status: "pending", dependencies: [], inputArtifacts: [], outputArtifacts: [], executions: [], createdAt: "", updatedAt: "" },
      ] }),
    ]);
    render(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText("2 nodes")).toBeInTheDocument();
    });
  });

  it("shows project CWD when provided", async () => {
    apiMocks.listBlueprints.mockResolvedValue([
      makeMockBlueprint({ id: "bp-1", title: "CWD BP", status: "approved", projectCwd: "/path/to/project" }),
    ]);
    render(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText("/path/to/project")).toBeInTheDocument();
    });
  });
});
