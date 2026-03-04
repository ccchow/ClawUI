import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import BlueprintsPage from "./page";
import { makeMockBlueprint, renderWithProviders } from "@/test-utils";
import type { Blueprint } from "@/lib/api";

// --- Mocks ---

const apiMocks = vi.hoisted(() => ({
  archiveBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
  unarchiveBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
  starBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
  unstarBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({} as Blueprint)),
}));

const hookState = vi.hoisted(() => ({
  blueprints: [] as Blueprint[],
  loading: false,
  error: null as string | null,
  setBlueprints: vi.fn(),
  invalidateList: vi.fn(),
  prefetchBlueprintDetail: vi.fn(),
  queryClient: {} as unknown,
}));

// Mock the api module — only the functions directly imported by the page component
vi.mock("@/lib/api", () => ({
  ...apiMocks,
}));

// Mock the custom hook to avoid importing @tanstack/react-query in the worker
vi.mock("@/lib/useBlueprintListQuery", () => ({
  useBlueprintListQuery: vi.fn(() => hookState),
}));

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), back: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  usePathname: vi.fn(() => "/blueprints"),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className, onMouseEnter, onFocus }: { href: string; children: React.ReactNode; className?: string; onMouseEnter?: () => void; onFocus?: () => void }) => (
    <a href={href} className={className} onMouseEnter={onMouseEnter} onFocus={onFocus}>{children}</a>
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

function setupHook(overrides: Partial<typeof hookState> = {}) {
  hookState.blueprints = overrides.blueprints ?? [];
  hookState.loading = overrides.loading ?? false;
  hookState.error = overrides.error ?? null;
  hookState.setBlueprints = overrides.setBlueprints ?? vi.fn();
  hookState.invalidateList = overrides.invalidateList ?? vi.fn();
  hookState.prefetchBlueprintDetail = overrides.prefetchBlueprintDetail ?? vi.fn();
}

// --- Tests ---

describe("BlueprintsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHook();
    // Stub sessionStorage
    vi.stubGlobal("sessionStorage", { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() });
  });

  it("renders blueprint cards from listBlueprints response", async () => {
    setupHook({ blueprints: makeBlueprints() });

    renderWithProviders(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText("Auth System")).toBeInTheDocument();
    });
  });

  it("shows 'New Blueprint' link", async () => {
    setupHook({ blueprints: makeBlueprints() });
    renderWithProviders(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText("Auth System")).toBeInTheDocument();
    });

    const newLink = screen.getByText("New Blueprint");
    expect(newLink.closest("a")).toHaveAttribute("href", "/blueprints/new");
  });

  it("filters by status when clicking status chips", async () => {
    setupHook({ blueprints: makeBlueprints() });
    renderWithProviders(<BlueprintsPage />);

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
    setupHook({ blueprints: makeBlueprints() });
    renderWithProviders(<BlueprintsPage />);

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
    const setBlueprints = vi.fn();
    setupHook({
      blueprints: [makeMockBlueprint({ id: "bp-1", title: "My BP", status: "approved" })],
      setBlueprints,
    });
    apiMocks.archiveBlueprint.mockResolvedValue(makeMockBlueprint({ id: "bp-1", archivedAt: "2025-01-01" }));

    renderWithProviders(<BlueprintsPage />);

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
    const setBlueprints = vi.fn();
    setupHook({
      blueprints: [makeMockBlueprint({ id: "bp-archived", title: "Archived BP", status: "done", archivedAt: "2025-01-01" })],
      setBlueprints,
    });
    apiMocks.unarchiveBlueprint.mockResolvedValue(
      makeMockBlueprint({ id: "bp-archived", title: "Archived BP", archivedAt: undefined }),
    );

    renderWithProviders(<BlueprintsPage />);

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
    setupHook({ blueprints: [] });
    renderWithProviders(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText("No blueprints yet.")).toBeInTheDocument();
    });
  });

  it("shows error message when API fails", async () => {
    setupHook({ error: "Network error" });
    renderWithProviders(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load blueprints/)).toBeInTheDocument();
      expect(screen.getByText(/Network error/)).toBeInTheDocument();
    });
  });

  it("shows node count for each blueprint", async () => {
    setupHook({
      blueprints: [
        makeMockBlueprint({ id: "bp-1", title: "Multi Node BP", status: "approved", nodes: [
          { id: "n1", blueprintId: "bp-1", order: 0, seq: 1, title: "N1", description: "", status: "pending", dependencies: [], inputArtifacts: [], outputArtifacts: [], executions: [], createdAt: "", updatedAt: "" },
          { id: "n2", blueprintId: "bp-1", order: 1, seq: 2, title: "N2", description: "", status: "pending", dependencies: [], inputArtifacts: [], outputArtifacts: [], executions: [], createdAt: "", updatedAt: "" },
        ] }),
      ],
    });
    renderWithProviders(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText("2 nodes")).toBeInTheDocument();
    });
  });

  it("shows project CWD when provided", async () => {
    setupHook({
      blueprints: [makeMockBlueprint({ id: "bp-1", title: "CWD BP", status: "approved", projectCwd: "/path/to/project" })],
    });
    renderWithProviders(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText("/path/to/project")).toBeInTheDocument();
    });
  });

  it("triggers prefetch on link hover", async () => {
    const prefetchFn = vi.fn();
    setupHook({
      blueprints: [makeMockBlueprint({ id: "bp-prefetch", title: "Prefetch BP", status: "approved" })],
      prefetchBlueprintDetail: prefetchFn,
    });

    renderWithProviders(<BlueprintsPage />);

    await waitFor(() => {
      expect(screen.getByText("Prefetch BP")).toBeInTheDocument();
    });

    // Hover over the blueprint link to trigger prefetch
    const link = screen.getByText("Prefetch BP").closest("a")!;
    fireEvent.mouseEnter(link);

    expect(prefetchFn).toHaveBeenCalledWith("bp-prefetch");
  });

  it("shows loading skeleton when loading", () => {
    setupHook({ loading: true });
    renderWithProviders(<BlueprintsPage />);
    expect(screen.getByTestId("skeleton-loader")).toBeInTheDocument();
  });
});
