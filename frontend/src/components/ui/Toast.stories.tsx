import type { Meta, StoryObj } from "@storybook/react";

import { Button } from "./Button";
import { ToastProvider, useToast } from "./Toast";

function ToastDemo() {
  const { toast } = useToast();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => toast("Deposit successful.")}>
        Show success
      </Button>
      <Button variant="outline" onClick={() => toast("Error: Wallet rejected the request.")}>
        Show error
      </Button>
      <Button variant="outline" onClick={() => toast("Waiting for confirmation…")}>
        Show info
      </Button>
    </div>
  );
}

const meta = {
  title: "UI/Toast",
  component: ToastProvider,
  tags: ["autodocs"],
  render: (args) => (
    <ToastProvider {...args}>
      <ToastDemo />
    </ToastProvider>
  ),
  args: {
    children: null,
  },
} satisfies Meta<typeof ToastProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};