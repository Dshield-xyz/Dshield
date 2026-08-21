// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./Button";

describe("Button", () => {
  it("renders children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("applies variant classes", () => {
    const { container } = render(<Button variant="outline">Outline</Button>);
    const btn = container.querySelector("button");
    expect(btn?.className).toContain("border-zinc-700");
  });

  it("applies size classes", () => {
    const { container } = render(<Button size="lg">Large</Button>);
    const btn = container.querySelector("button");
    expect(btn?.className).toContain("px-8");
  });

  it("applies fullWidth class", () => {
    const { container } = render(<Button fullWidth>Full</Button>);
    const btn = container.querySelector("button");
    expect(btn?.className).toContain("w-full");
  });

  it("calls onClick when clicked", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);
    await userEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not call onClick when disabled", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick} disabled>Disabled</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders as a primary variant by default", () => {
    const { container } = render(<Button>Default</Button>);
    const btn = container.querySelector("button");
    expect(btn?.className).toContain("bg-gradient-to-b");
  });
});