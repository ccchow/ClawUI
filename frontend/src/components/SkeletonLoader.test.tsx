import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { SkeletonLoader } from "./SkeletonLoader";

describe("SkeletonLoader", () => {
  describe("card variant", () => {
    it("renders a single card skeleton by default", () => {
      const { container } = render(<SkeletonLoader variant="card" />);
      // Card variant renders a single card, not wrapped in a space-y container
      const card = container.querySelector("[class*='rounded-xl']");
      expect(card).toBeInTheDocument();
    });

    it("renders skeleton lines with animate-pulse", () => {
      const { container } = render(<SkeletonLoader variant="card" />);
      const pulsingElements = container.querySelectorAll("[class*='animate-pulse']");
      expect(pulsingElements.length).toBeGreaterThan(0);
    });

    it("ignores count param for card variant (renders single card)", () => {
      const { container } = render(<SkeletonLoader variant="card" count={5} />);
      // Card variant renders a single card regardless of count
      const cards = container.querySelectorAll("[class*='rounded-xl']");
      expect(cards.length).toBe(1);
    });
  });

  describe("list variant", () => {
    it("renders multiple card skeletons based on count", () => {
      const { container } = render(<SkeletonLoader variant="list" count={4} />);
      const cards = container.querySelectorAll("[class*='rounded-xl']");
      expect(cards.length).toBe(4);
    });

    it("defaults to 3 items when count is not specified", () => {
      const { container } = render(<SkeletonLoader variant="list" />);
      const cards = container.querySelectorAll("[class*='rounded-xl']");
      expect(cards.length).toBe(3);
    });

    it("wraps items in a space-y container", () => {
      const { container } = render(<SkeletonLoader variant="list" />);
      const wrapper = container.querySelector("[class*='space-y-2']");
      expect(wrapper).toBeInTheDocument();
    });
  });

  describe("nodeCard variant", () => {
    it("renders node card skeletons based on count", () => {
      const { container } = render(<SkeletonLoader variant="nodeCard" count={2} />);
      const cards = container.querySelectorAll("[class*='rounded-xl']");
      expect(cards.length).toBe(2);
    });

    it("defaults to 3 node card items", () => {
      const { container } = render(<SkeletonLoader variant="nodeCard" />);
      const cards = container.querySelectorAll("[class*='rounded-xl']");
      expect(cards.length).toBe(3);
    });

    it("wraps node cards in a space-y container", () => {
      const { container } = render(<SkeletonLoader variant="nodeCard" />);
      const wrapper = container.querySelector("[class*='space-y-2']");
      expect(wrapper).toBeInTheDocument();
    });

    it("renders rounded-full status indicator placeholder", () => {
      const { container } = render(<SkeletonLoader variant="nodeCard" count={1} />);
      const statusDot = container.querySelector("[class*='rounded-full']");
      expect(statusDot).toBeInTheDocument();
    });
  });

  describe("nodeDetail variant", () => {
    it("renders a single node detail skeleton regardless of count", () => {
      const { container } = render(<SkeletonLoader variant="nodeDetail" count={5} />);
      // nodeDetail renders a single skeleton layout
      const wrapper = container.querySelector("[class*='space-y-6']");
      expect(wrapper).toBeInTheDocument();
    });

    it("renders back link placeholder", () => {
      const { container } = render(<SkeletonLoader variant="nodeDetail" />);
      const backLink = container.querySelector("[class*='w-32']");
      expect(backLink).toBeInTheDocument();
    });

    it("renders title bar with status indicator", () => {
      const { container } = render(<SkeletonLoader variant="nodeDetail" />);
      // Title bar area
      const titleArea = container.querySelector("[class*='flex items-center gap-3']");
      expect(titleArea).toBeInTheDocument();
    });

    it("renders description block placeholder", () => {
      const { container } = render(<SkeletonLoader variant="nodeDetail" />);
      // Description block with border
      const descBlock = container.querySelector("[class*='rounded-xl'][class*='border']");
      expect(descBlock).toBeInTheDocument();
    });

    it("renders action buttons area", () => {
      const { container } = render(<SkeletonLoader variant="nodeDetail" />);
      const actionsArea = container.querySelector("[class*='flex gap-2']");
      expect(actionsArea).toBeInTheDocument();
    });

    it("renders animate-pulse elements", () => {
      const { container } = render(<SkeletonLoader variant="nodeDetail" />);
      const pulsing = container.querySelectorAll("[class*='animate-pulse']");
      expect(pulsing.length).toBeGreaterThan(0);
    });
  });
});
