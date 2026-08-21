import type { Meta, StoryObj } from "@storybook/react";

import { Spinner } from "./Spinner";

const meta = {
  title: "UI/Spinner",
  component: Spinner,
  tags: ["autodocs"],
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Large: Story = {
  args: {
    className: "h-8 w-8",
  },
};

export const InContext: Story = {
  render: () => (
    <div className="flex items-center gap-3 text-sm text-zinc-400">
      <Spinner />
      Processing withdrawal…
    </div>
  ),
};