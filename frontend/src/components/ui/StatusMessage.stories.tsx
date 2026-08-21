import type { Meta, StoryObj } from "@storybook/react";

import { StatusMessage } from "./StatusMessage";

const meta = {
  title: "UI/StatusMessage",
  component: StatusMessage,
  tags: ["autodocs"],
} satisfies Meta<typeof StatusMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = {
  args: {
    message: "Waiting for confirmation…",
  },
};

export const Success: Story = {
  args: {
    message: "Deposit successful — note stored.",
  },
};

export const Error: Story = {
  args: {
    message: "Error: Transaction rejected by wallet.",
  },
};

export const WithCustomHints: Story = {
  args: {
    message: "Wrap completed — 100 USDC ready.",
    successHints: ["completed"],
  },
};