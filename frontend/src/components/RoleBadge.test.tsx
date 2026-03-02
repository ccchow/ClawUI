import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoleBadge } from "./RoleBadge";

describe("RoleBadge", () => {
  it("renders role label for known role", () => {
    render(<RoleBadge roleId="sde" />);
    expect(screen.getByText("SDE")).toBeInTheDocument();
  });

  it("renders uppercase roleId for unknown role", () => {
    render(<RoleBadge roleId="devops" />);
    expect(screen.getByText("DEVOPS")).toBeInTheDocument();
  });

  it("uses role-specific colors when not inherited", () => {
    render(<RoleBadge roleId="sde" />);
    const badge = screen.getByText("SDE").closest("span")!;
    expect(badge.className).toContain("bg-accent-blue/15");
    expect(badge.className).toContain("text-accent-blue");
    expect(badge.className).toContain("border-accent-blue/30");
    expect(badge.className).not.toContain("border-dashed");
    expect(badge.className).not.toContain("opacity-60");
  });

  it("uses muted/dashed styling when inherited", () => {
    render(<RoleBadge roleId="sde" inherited />);
    const badge = screen.getByText("SDE").closest("span")!;
    expect(badge.className).toContain("bg-bg-tertiary");
    expect(badge.className).toContain("text-accent-blue");
    expect(badge.className).toContain("border-dashed");
    expect(badge.className).toContain("opacity-60");
    // Should NOT have the colored bg
    expect(badge.className).not.toContain("bg-accent-blue/15");
  });

  it("shows inherited tooltip when inherited", () => {
    render(<RoleBadge roleId="qa" inherited />);
    const badge = screen.getByText("QA").closest("span")!;
    expect(badge).toHaveAttribute("title", "Inherited from blueprint default");
  });

  it("does not show tooltip when not inherited", () => {
    render(<RoleBadge roleId="qa" />);
    const badge = screen.getByText("QA").closest("span")!;
    expect(badge).not.toHaveAttribute("title");
  });

  it("uses muted dot color when inherited", () => {
    render(<RoleBadge roleId="sde" inherited />);
    const badge = screen.getByText("SDE").closest("span")!;
    const dot = badge.querySelector("span:first-child")!;
    expect(dot.className).toContain("bg-text-muted");
    expect(dot.className).not.toContain("bg-accent-blue");
  });

  it("uses colored dot when not inherited", () => {
    render(<RoleBadge roleId="sde" />);
    const badge = screen.getByText("SDE").closest("span")!;
    const dot = badge.querySelector("span:first-child")!;
    expect(dot.className).toContain("bg-accent-blue");
  });

  it("applies xs size class", () => {
    render(<RoleBadge roleId="pm" size="xs" />);
    const badge = screen.getByText("PM").closest("span")!;
    expect(badge.className).toContain("text-[10px]");
  });

  it("applies sm size class by default", () => {
    render(<RoleBadge roleId="pm" />);
    const badge = screen.getByText("PM").closest("span")!;
    expect(badge.className).toContain("text-xs");
  });
});
