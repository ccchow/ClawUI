import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RoleSelector } from "./RoleSelector";

// Mock fetchRoles to return predictable role data
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<object>("@/lib/api");
  return {
    ...actual,
    fetchRoles: vi.fn(() =>
      Promise.resolve([
        { id: "sde", label: "SDE", description: "Software Development Engineer", builtin: true, artifactTypes: [], blockerTypes: [] },
        { id: "qa", label: "QA", description: "Quality Assurance", builtin: true, artifactTypes: [], blockerTypes: [] },
        { id: "pm", label: "PM", description: "Product Manager", builtin: true, artifactTypes: [], blockerTypes: [] },
      ])
    ),
  };
});

describe("RoleSelector", () => {
  let onChange: (roles: string[]) => void;

  beforeEach(() => {
    onChange = vi.fn();
  });

  it("renders all role buttons after loading", async () => {
    render(<RoleSelector value={["sde"]} onChange={onChange} />);
    expect(await screen.findByText("SDE")).toBeInTheDocument();
    expect(screen.getByText("QA")).toBeInTheDocument();
    expect(screen.getByText("PM")).toBeInTheDocument();
  });

  it("shows default 'Roles' label", async () => {
    render(<RoleSelector value={["sde"]} onChange={onChange} />);
    expect(await screen.findByText("Roles")).toBeInTheDocument();
  });

  it("hides label when label={null}", async () => {
    render(<RoleSelector value={["sde"]} onChange={onChange} label={null} />);
    await screen.findByText("SDE");
    expect(screen.queryByText("Roles")).not.toBeInTheDocument();
  });

  it("shows custom label", async () => {
    render(<RoleSelector value={["sde"]} onChange={onChange} label="Node Roles" />);
    expect(await screen.findByText("Node Roles")).toBeInTheDocument();
  });

  // --- Explicit (non-inherited) selection styling ---

  it("applies colored background to explicitly selected roles", async () => {
    render(<RoleSelector value={["sde"]} onChange={onChange} />);
    const sdeButton = await screen.findByText("SDE");
    const btn = sdeButton.closest("button")!;
    // Explicitly selected: should have colored bg class
    expect(btn.className).toContain("bg-accent-blue/15");
    expect(btn.className).toContain("text-accent-blue");
    expect(btn.className).toContain("border-accent-blue/30");
    // Should NOT have dashed border or reduced opacity
    expect(btn.className).not.toContain("border-dashed");
    expect(btn.className).not.toContain("opacity-60");
  });

  it("applies colored dot to explicitly selected roles", async () => {
    render(<RoleSelector value={["sde"]} onChange={onChange} />);
    const sdeButton = await screen.findByText("SDE");
    const dot = sdeButton.closest("button")!.querySelector("span")!;
    expect(dot.className).toContain("bg-accent-blue");
    expect(dot.className).not.toContain("bg-text-muted");
  });

  it("applies unselected style to non-selected roles", async () => {
    render(<RoleSelector value={["sde"]} onChange={onChange} />);
    const qaButton = (await screen.findByText("QA")).closest("button")!;
    expect(qaButton.className).toContain("bg-bg-tertiary");
    expect(qaButton.className).toContain("text-text-secondary");
    expect(qaButton.className).toContain("border-border-primary");
  });

  // --- Inherited selection styling ---

  it("applies muted/dimmed style to inherited selected roles", async () => {
    render(<RoleSelector value={["sde", "qa"]} onChange={onChange} inherited />);
    const sdeButton = (await screen.findByText("SDE")).closest("button")!;
    // Inherited: should have muted bg, dashed border, and reduced opacity
    expect(sdeButton.className).toContain("bg-bg-tertiary");
    expect(sdeButton.className).toContain("border-dashed");
    expect(sdeButton.className).toContain("opacity-60");
    // Should still have the role's text color
    expect(sdeButton.className).toContain("text-accent-blue");
    // Should NOT have the colored background
    expect(sdeButton.className).not.toContain("bg-accent-blue/15");
  });

  it("applies muted dot to inherited selected roles", async () => {
    render(<RoleSelector value={["sde"]} onChange={onChange} inherited />);
    const sdeButton = await screen.findByText("SDE");
    const dot = sdeButton.closest("button")!.querySelector("span")!;
    expect(dot.className).toContain("bg-text-muted");
    expect(dot.className).not.toContain("bg-accent-blue");
  });

  it("inherited non-selected roles use normal unselected style", async () => {
    render(<RoleSelector value={["sde"]} onChange={onChange} inherited />);
    const qaButton = (await screen.findByText("QA")).closest("button")!;
    // Non-selected roles should look the same whether inherited or not
    expect(qaButton.className).toContain("bg-bg-tertiary");
    expect(qaButton.className).toContain("text-text-secondary");
    expect(qaButton.className).not.toContain("border-dashed");
    expect(qaButton.className).not.toContain("opacity-60");
  });

  it("inherited=false (default) selected roles have full colored styling", async () => {
    render(<RoleSelector value={["qa"]} onChange={onChange} />);
    const qaButton = (await screen.findByText("QA")).closest("button")!;
    expect(qaButton.className).toContain("bg-accent-green/15");
    expect(qaButton.className).toContain("text-accent-green");
    expect(qaButton.className).not.toContain("border-dashed");
    expect(qaButton.className).not.toContain("opacity-60");
  });

  // --- Toggle behavior ---

  it("calls onChange with toggled role when clicking unselected role", async () => {
    render(<RoleSelector value={["sde"]} onChange={onChange} />);
    const qaButton = (await screen.findByText("QA")).closest("button")!;
    fireEvent.click(qaButton);
    expect(onChange).toHaveBeenCalledWith(["sde", "qa"]);
  });

  it("calls onChange when deselecting a selected role (keeps at least one)", async () => {
    render(<RoleSelector value={["sde", "qa"]} onChange={onChange} />);
    const qaButton = (await screen.findByText("QA")).closest("button")!;
    fireEvent.click(qaButton);
    expect(onChange).toHaveBeenCalledWith(["sde"]);
  });

  it("prevents deselecting the last remaining role", async () => {
    render(<RoleSelector value={["sde"]} onChange={onChange} />);
    const sdeButton = (await screen.findByText("SDE")).closest("button")!;
    fireEvent.click(sdeButton);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("calls onChange when toggling an inherited role (transitions to explicit)", async () => {
    render(<RoleSelector value={["sde", "qa"]} onChange={onChange} inherited />);
    // Clicking an inherited-selected role should deselect it → explicit roles
    const qaButton = (await screen.findByText("QA")).closest("button")!;
    fireEvent.click(qaButton);
    expect(onChange).toHaveBeenCalledWith(["sde"]);
  });

  it("calls onChange when selecting a new role in inherited mode", async () => {
    render(<RoleSelector value={["sde"]} onChange={onChange} inherited />);
    const pmButton = (await screen.findByText("PM")).closest("button")!;
    fireEvent.click(pmButton);
    expect(onChange).toHaveBeenCalledWith(["sde", "pm"]);
  });

  // --- Disabled state ---

  it("does not call onChange when disabled", async () => {
    render(<RoleSelector value={["sde"]} onChange={onChange} disabled />);
    const qaButton = (await screen.findByText("QA")).closest("button")!;
    fireEvent.click(qaButton);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("applies disabled opacity", async () => {
    render(<RoleSelector value={["sde"]} onChange={onChange} disabled />);
    const sdeButton = (await screen.findByText("SDE")).closest("button")!;
    expect(sdeButton.className).toContain("opacity-50");
    expect(sdeButton.className).toContain("cursor-not-allowed");
  });

  // --- Multiple roles styling ---

  it("styles multiple inherited roles consistently", async () => {
    render(<RoleSelector value={["sde", "qa", "pm"]} onChange={onChange} inherited />);
    const sdeButton = (await screen.findByText("SDE")).closest("button")!;
    const qaButton = screen.getByText("QA").closest("button")!;
    const pmButton = screen.getByText("PM").closest("button")!;

    for (const btn of [sdeButton, qaButton, pmButton]) {
      expect(btn.className).toContain("border-dashed");
      expect(btn.className).toContain("opacity-60");
      expect(btn.className).toContain("bg-bg-tertiary");
    }

    // Each should still have its own text color
    expect(sdeButton.className).toContain("text-accent-blue");
    expect(qaButton.className).toContain("text-accent-green");
    expect(pmButton.className).toContain("text-accent-purple");
  });
});
