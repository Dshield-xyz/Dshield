// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input } from "./Input";

describe("Input", () => {
  it("renders an input element", () => {
    render(<Input />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("renders a label when provided", () => {
    render(<Input label="Amount" />);
    expect(screen.getByText("Amount")).toBeInTheDocument();
    expect(screen.getByLabelText("Amount")).toBeInTheDocument();
  });

  it("renders hint text when provided", () => {
    render(<Input hint="Enter a value" />);
    expect(screen.getByText("Enter a value")).toBeInTheDocument();
  });

  it("applies monospace class when mono is true", () => {
    const { container } = render(<Input mono />);
    const input = container.querySelector("input");
    expect(input?.className).toContain("font-mono");
  });

  it("calls onChange when value changes", async () => {
    const onChange = vi.fn();
    render(<Input onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await userEvent.type(input, "abc");
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("forwards placeholder text", () => {
    render(<Input placeholder="0x..." />);
    expect(screen.getByPlaceholderText("0x...")).toBeInTheDocument();
  });

  it("disables the input when disabled prop is set", () => {
    render(<Input disabled />);
    expect(screen.getByRole("textbox")).toBeDisabled();
  });
});