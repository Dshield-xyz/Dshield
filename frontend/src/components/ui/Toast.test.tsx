// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider, useToast } from "./Toast";

/** Helper component that programmatically shows a toast. */
function ToastTrigger({ message, tone }: { message: string; tone?: "info" | "success" | "error" }) {
  const { toast } = useToast();
  return (
    <button type="button" onClick={() => toast(message, tone)}>
      Show Toast
    </button>
  );
}

describe("ToastProvider + useToast", () => {
  it("renders children", () => {
    render(
      <ToastProvider>
        <p>App content</p>
      </ToastProvider>,
    );
    expect(screen.getByText("App content")).toBeInTheDocument();
  });

  it("shows a toast message when triggered", async () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Note saved successfully" />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByText("Show Toast"));
    expect(screen.getByText("Note saved successfully")).toBeInTheDocument();
  });

  it("shows a success toast with green styling", async () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Done" />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByText("Show Toast"));
    const toastEl = screen.getByText("Done").closest("[class*='rounded-xl']");
    expect(toastEl?.className).toContain("green");
  });

  it("shows an error toast with error styling", async () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Error: something went wrong" />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByText("Show Toast"));
    const toastEl = screen.getByText("Error: something went wrong").closest("[class*='rounded-xl']");
    expect(toastEl?.className).toContain("red");
  });

  it("dismisses toast when dismiss button is clicked", async () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Dismiss me" />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByText("Show Toast"));
    expect(screen.getByText("Dismiss me")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("Dismiss me")).not.toBeInTheDocument();
  });

  it("renders aria-live region for announcements", () => {
    render(
      <ToastProvider>
        <ToastTrigger message="Hello" />
      </ToastProvider>,
    );
    const liveRegion = document.querySelector("[aria-live='polite']");
    expect(liveRegion).not.toBeNull();
    expect(liveRegion?.getAttribute("aria-live")).toBe("polite");
  });

  it("can show multiple toasts", async () => {
    render(
      <ToastProvider>
        <ToastTrigger message="First" />
        <ToastTrigger message="Second" />
      </ToastProvider>,
    );

    await userEvent.click(screen.getAllByText("Show Toast")[0]);
    await userEvent.click(screen.getAllByText("Show Toast")[1]);
    expect(screen.getByText("First")).toBeInTheDocument();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });
});