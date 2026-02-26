import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NavBar } from "./NavBar";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/"),
  useRouter: vi.fn(() => ({ push: vi.fn() })),
}));

// Mock next/link
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

// Mock @/lib/api
vi.mock("@/lib/api", () => ({
  redeployStable: vi.fn(async () => {}),
  getDevStatus: vi.fn(async () => ({ devMode: false })),
  getGlobalStatus: vi.fn(async () => ({ active: false, totalPending: 0, tasks: [] })),
}));

// Mock AISparkle
vi.mock("./AISparkle", () => ({
  AISparkle: ({ size }: { size?: string }) => <span data-testid="ai-sparkle" data-size={size} />,
}));

import { usePathname } from "next/navigation";
const mockUsePathname = vi.mocked(usePathname);

describe("NavBar", () => {
  it("renders the ClawUI brand name", () => {
    render(<NavBar />);
    expect(screen.getByText("ClawUI")).toBeInTheDocument();
  });

  it("renders Sessions and Blueprints nav links", () => {
    render(<NavBar />);
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Blueprints")).toBeInTheDocument();
  });

  it("highlights Sessions link when on sessions page", () => {
    mockUsePathname.mockReturnValue("/sessions");
    render(<NavBar />);
    const sessionsLink = screen.getByText("Sessions");
    expect(sessionsLink.className).toContain("font-medium");
  });

  it("highlights Sessions link when on session detail page", () => {
    mockUsePathname.mockReturnValue("/session/abc-123");
    render(<NavBar />);
    const sessionsLink = screen.getByText("Sessions");
    expect(sessionsLink.className).toContain("font-medium");
  });

  it("highlights Blueprints link when on blueprints page", () => {
    mockUsePathname.mockReturnValue("/blueprints");
    render(<NavBar />);
    const blueprintsLink = screen.getByText("Blueprints");
    expect(blueprintsLink.className).toContain("font-medium");
  });

  it("highlights Blueprints link on blueprint detail page", () => {
    mockUsePathname.mockReturnValue("/blueprints/bp-123");
    render(<NavBar />);
    const blueprintsLink = screen.getByText("Blueprints");
    expect(blueprintsLink.className).toContain("font-medium");
  });

  it("does not highlight Sessions on blueprints page", () => {
    mockUsePathname.mockReturnValue("/blueprints");
    render(<NavBar />);
    const sessionsLink = screen.getByText("Sessions");
    expect(sessionsLink.className).not.toContain("font-medium");
  });

  it("renders home link pointing to blueprints", () => {
    render(<NavBar />);
    const links = screen.getAllByRole("link");
    const homeLink = links.find((l) => l.getAttribute("href") === "/blueprints");
    expect(homeLink).toBeTruthy();
  });

  it("renders paw emoji", () => {
    const { container } = render(<NavBar />);
    expect(container.textContent).toContain("\uD83D\uDC3E");
  });
});
