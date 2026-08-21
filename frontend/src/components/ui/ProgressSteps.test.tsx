// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProgressSteps } from "./ProgressSteps";

const STEPS = ["step_a", "step_b", "step_c"] as const;

function getSegments(container: HTMLElement): Element[] {
  const bar = container.querySelector('[role="progressbar"]');
  if (!bar) return [];
  return Array.from(bar.querySelectorAll("div"));
}

describe("ProgressSteps", () => {
  it("renders the current step label", () => {
    render(<ProgressSteps label="Processing…" steps={STEPS} current="step_b" />);
    expect(screen.getByText("Processing…")).toBeInTheDocument();
  });

  it("renders all step segments", () => {
    const { container } = render(
      <ProgressSteps label="Test" steps={STEPS} current="step_b" />,
    );
    expect(getSegments(container).length).toBe(STEPS.length);
  });

  it("fills segments up to the current step index", () => {
    const { container } = render(
      <ProgressSteps label="Test" steps={STEPS} current="step_b" />,
    );
    const segments = getSegments(container);
    // step_b is index 1, so segment 0 and 1 should be filled (bg-white),
    // segment 2 should be unfilled (bg-zinc-700)
    expect(segments[0].className).toContain("bg-white");
    expect(segments[1].className).toContain("bg-white");
    expect(segments[2].className).toContain("bg-zinc-700");
  });

  it("renders a progressbar with correct aria-valuenow", () => {
    render(<ProgressSteps label="Test" steps={STEPS} current="step_b" />);
    const progressbar = screen.getByRole("progressbar");
    expect(progressbar).toHaveAttribute("aria-valuenow", "67");
    expect(progressbar).toHaveAttribute("aria-valuemin", "0");
    expect(progressbar).toHaveAttribute("aria-valuemax", "100");
  });

  it("handles the first step correctly", () => {
    const { container } = render(
      <ProgressSteps label="Start" steps={STEPS} current="step_a" />,
    );
    const segments = getSegments(container);
    expect(segments[0].className).toContain("bg-white");
    expect(segments[1].className).toContain("bg-zinc-700");
    expect(segments[2].className).toContain("bg-zinc-700");

    const progressbar = screen.getByRole("progressbar");
    expect(progressbar).toHaveAttribute("aria-valuenow", "33");
  });

  it("handles the last step correctly", () => {
    const { container } = render(
      <ProgressSteps label="Done" steps={STEPS} current="step_c" />,
    );
    const segments = getSegments(container);
    expect(segments[0].className).toContain("bg-white");
    expect(segments[1].className).toContain("bg-white");
    expect(segments[2].className).toContain("bg-white");

    const progressbar = screen.getByRole("progressbar");
    expect(progressbar).toHaveAttribute("aria-valuenow", "100");
  });
});