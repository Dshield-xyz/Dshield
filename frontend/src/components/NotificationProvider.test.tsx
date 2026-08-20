// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { NotificationProvider, useNotify } from "./NotificationProvider";
import { ToastProvider } from "@/components/ui/Toast";

/**
 * Test helper that renders a test component inside the provider tree.
 * The test component invokes the requested notify method and the test
 * asserts on the resulting toast DOM.
 */
function renderWithNotify() {
  let notify!: ReturnType<typeof useNotify>;
  function TestHarness() {
    notify = useNotify();
    return null;
  }
  render(
    <ToastProvider>
      <NotificationProvider>
        <TestHarness />
      </NotificationProvider>
    </ToastProvider>,
  );
  return notify;
}

describe("NotificationProvider / useNotify", () => {
  it("notify(info) renders a toast with the given message", () => {
    const notify = renderWithNotify();
    act(() => {
      notify.notify("Hello world");
    });
    expect(screen.getByText("Hello world")).toBeTruthy();
  });

  it("notify(success) renders a success-toned toast", () => {
    const notify = renderWithNotify();
    act(() => {
      notify.notify("Task complete", "success");
    });
    expect(screen.getByText("Task complete")).toBeTruthy();
  });

  it("notifyError converts an error object to a readable message", () => {
    const notify = renderWithNotify();
    act(() => {
      notify.notifyError(new Error("user declined"));
    });
    expect(
      screen.getByText(
        "Cancelled — you declined the signature in your wallet.",
      ),
    ).toBeTruthy();
  });

  it("notifyError with a fallback uses fallback when raw message is too long", () => {
    const notify = renderWithNotify();
    const longMsg = new Error("x".repeat(150));
    act(() => {
      notify.notifyError(longMsg, "Custom fallback message");
    });
    expect(screen.getByText("Custom fallback message")).toBeTruthy();
  });

  it("notifyError renders error tone for unknown errors", () => {
    const notify = renderWithNotify();
    act(() => {
      notify.notifyError("some random string");
    });
    expect(screen.getByText("some random string")).toBeTruthy();
    const toastEl = screen.getByText("some random string").closest('[class*="border-"]');
    expect(toastEl).not.toBeNull();
  });

  it("notifySuccess renders a success-toned toast", () => {
    const notify = renderWithNotify();
    act(() => {
      notify.notifySuccess("Done!");
    });
    expect(screen.getByText("Done!")).toBeTruthy();
    const toastEl = screen.getByText("Done!").closest('[class*="border-"]');
    expect(toastEl).not.toBeNull();
  });

  it("multiple toasts stack", () => {
    const notify = renderWithNotify();
    act(() => {
      notify.notify("First");
      notify.notify("Second");
    });
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
  });
});