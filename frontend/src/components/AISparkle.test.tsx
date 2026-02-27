import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { AISparkle } from "./AISparkle";

describe("AISparkle", () => {
  it("renders an SVG element", () => {
    const { container } = render(<AISparkle />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });

  it("applies animate-ai-sparkle class", () => {
    const { container } = render(<AISparkle />);
    const svg = container.querySelector("svg");
    expect(svg?.className.baseVal).toContain("animate-ai-sparkle");
  });

  it("renders with sm size by default", () => {
    const { container } = render(<AISparkle />);
    const svg = container.querySelector("svg");
    expect(svg?.className.baseVal).toContain("w-3.5");
    expect(svg?.className.baseVal).toContain("h-3.5");
  });

  it("renders with xs size when specified", () => {
    const { container } = render(<AISparkle size="xs" />);
    const svg = container.querySelector("svg");
    expect(svg?.className.baseVal).toContain("w-3");
    expect(svg?.className.baseVal).toContain("h-3");
  });

  it("renders with md size when specified", () => {
    const { container } = render(<AISparkle size="md" />);
    const svg = container.querySelector("svg");
    expect(svg?.className.baseVal).toContain("w-4");
    expect(svg?.className.baseVal).toContain("h-4");
  });

  it("appends custom className", () => {
    const { container } = render(<AISparkle className="text-red-500" />);
    const svg = container.querySelector("svg");
    expect(svg?.className.baseVal).toContain("text-red-500");
  });

  it("uses currentColor as fill", () => {
    const { container } = render(<AISparkle />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("currentColor");
  });

  it("has the 24x24 viewBox", () => {
    const { container } = render(<AISparkle />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("contains a sparkle path element", () => {
    const { container } = render(<AISparkle />);
    const path = container.querySelector("svg path");
    expect(path).toBeInTheDocument();
    expect(path?.getAttribute("d")).toBeTruthy();
  });
});
