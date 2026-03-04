import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import NewBlueprintPage from "./page";
import { makeMockBlueprint } from "@/test-utils";

// --- Mocks ---

import type { Blueprint, RoleInfo, AgentInfo } from "@/lib/api";

const apiMocks = vi.hoisted(() => ({
  createBlueprint: vi.fn((): Promise<Blueprint> => Promise.resolve({
    id: "bp-1", title: "Test", description: "", status: "draft",
    nodes: [], createdAt: "", updatedAt: "",
  } as Blueprint)),
  fetchRoles: vi.fn((): Promise<RoleInfo[]> => Promise.resolve([])),
  getAgents: vi.fn((): Promise<AgentInfo[]> => Promise.resolve([])),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<object>("@/lib/api");
  return { ...actual, ...apiMocks };
});

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: mockPush, back: vi.fn() })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  usePathname: vi.fn(() => "/blueprints/new"),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

// Mock MarkdownEditor as a simple textarea
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <textarea
      data-testid="markdown-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  ),
}));

// Mock AgentSelector
vi.mock("@/components/AgentSelector", () => ({
  AgentSelector: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <select data-testid="agent-selector" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="claude">Claude</option>
      <option value="openclaw">OpenClaw</option>
    </select>
  ),
}));

// Mock RoleSelector
vi.mock("@/components/RoleSelector", () => ({
  RoleSelector: ({ value }: { value: string[] }) => (
    <div data-testid="role-selector">
      <span data-testid="selected-roles">{value.join(",")}</span>
    </div>
  ),
}));

// --- Tests ---

describe("NewBlueprintPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders form with title, description, projectCwd, agent selector, and role selector", () => {
    render(<NewBlueprintPage />);

    expect(screen.getByLabelText(/Title/)).toBeInTheDocument();
    expect(screen.getByTestId("markdown-editor")).toBeInTheDocument();
    expect(screen.getByLabelText(/Project Directory/)).toBeInTheDocument();
    expect(screen.getByTestId("agent-selector")).toBeInTheDocument();
    expect(screen.getByTestId("role-selector")).toBeInTheDocument();
  });

  it("shows 'New Blueprint' heading", () => {
    render(<NewBlueprintPage />);
    expect(screen.getByText("New Blueprint")).toBeInTheDocument();
  });

  it("has 'Create Blueprint' and 'Create & Generate' buttons", () => {
    render(<NewBlueprintPage />);
    expect(screen.getByText("Create Blueprint")).toBeInTheDocument();
    expect(screen.getByText("Create & Generate")).toBeInTheDocument();
  });

  it("Create Blueprint button is disabled when title is empty", () => {
    render(<NewBlueprintPage />);

    const submitBtn = screen.getByText("Create Blueprint");
    expect(submitBtn).toBeDisabled();
  });

  it("calls createBlueprint with correct arguments on form submit", async () => {
    const createdBp = makeMockBlueprint({ id: "bp-new" });
    apiMocks.createBlueprint.mockResolvedValue(createdBp);

    render(<NewBlueprintPage />);

    // Fill in title
    const titleInput = screen.getByLabelText(/Title/);
    fireEvent.change(titleInput, { target: { value: "My New Blueprint" } });

    // Fill in description
    const descInput = screen.getByTestId("markdown-editor");
    fireEvent.change(descInput, { target: { value: "Some description" } });

    // Fill in projectCwd
    const cwdInput = screen.getByLabelText(/Project Directory/);
    fireEvent.change(cwdInput, { target: { value: "/home/user/project" } });

    // Submit form
    const submitBtn = screen.getByText("Create Blueprint");
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(apiMocks.createBlueprint).toHaveBeenCalledWith({
        title: "My New Blueprint",
        description: "Some description",
        projectCwd: "/home/user/project",
        agentType: "claude",
        enabledRoles: ["sde", "qa", "pm", "uxd"],
        defaultRole: "sde",
      });
    });

    // Should redirect to the new blueprint
    expect(mockPush).toHaveBeenCalledWith("/blueprints/bp-new");
  });

  it("'Create & Generate' button redirects with ?generate=true", async () => {
    const createdBp = makeMockBlueprint({ id: "bp-gen" });
    apiMocks.createBlueprint.mockResolvedValue(createdBp);

    render(<NewBlueprintPage />);

    // Fill in title
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Gen Blueprint" } });

    // Click "Create & Generate"
    const genBtn = screen.getByText("Create & Generate");
    fireEvent.click(genBtn);

    await waitFor(() => {
      expect(apiMocks.createBlueprint).toHaveBeenCalled();
    });

    expect(mockPush).toHaveBeenCalledWith("/blueprints/bp-gen?generate=true");
  });

  it("shows error when createBlueprint fails", async () => {
    apiMocks.createBlueprint.mockRejectedValue(new Error("Server error"));

    render(<NewBlueprintPage />);

    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Failing BP" } });
    fireEvent.click(screen.getByText("Create Blueprint"));

    await waitFor(() => {
      expect(screen.getByText("Server error")).toBeInTheDocument();
    });
  });

  it("shows CWD-specific error for directory validation failures", async () => {
    apiMocks.createBlueprint.mockRejectedValue(new Error("not a directory"));

    render(<NewBlueprintPage />);

    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Bad CWD BP" } });
    fireEvent.change(screen.getByLabelText(/Project Directory/), { target: { value: "/bad/path" } });
    fireEvent.click(screen.getByText("Create Blueprint"));

    await waitFor(() => {
      expect(screen.getByText("not a directory")).toBeInTheDocument();
    });
  });

  it("does not submit when title is empty (form validation)", async () => {
    render(<NewBlueprintPage />);

    // Title is empty, submit button should be disabled
    const submitBtn = screen.getByText("Create Blueprint");
    expect(submitBtn).toBeDisabled();

    // Try clicking anyway
    fireEvent.click(submitBtn);

    expect(apiMocks.createBlueprint).not.toHaveBeenCalled();
  });

  it("has Cancel link back to blueprints", () => {
    render(<NewBlueprintPage />);

    const cancelLink = screen.getByText("Cancel");
    expect(cancelLink.closest("a")).toHaveAttribute("href", "/blueprints");
  });

  it("has Back to Blueprints link", () => {
    render(<NewBlueprintPage />);

    const backLink = screen.getByText("← Back to Blueprints");
    expect(backLink.closest("a")).toHaveAttribute("href", "/blueprints");
  });

  it("omits empty description and projectCwd from API call", async () => {
    const createdBp = makeMockBlueprint({ id: "bp-minimal" });
    apiMocks.createBlueprint.mockResolvedValue(createdBp);

    render(<NewBlueprintPage />);

    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Minimal BP" } });
    fireEvent.click(screen.getByText("Create Blueprint"));

    await waitFor(() => {
      expect(apiMocks.createBlueprint).toHaveBeenCalledWith({
        title: "Minimal BP",
        description: undefined,
        projectCwd: undefined,
        agentType: "claude",
        enabledRoles: ["sde", "qa", "pm", "uxd"],
        defaultRole: "sde",
      });
    });
  });
});
