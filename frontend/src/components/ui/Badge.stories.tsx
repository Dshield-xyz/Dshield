import type { Meta, StoryObj } from "@storybook/react";

import { Badge } from "./Badge";

const meta = {
  title: "UI/Badge",
  component: Badge,
  tags: ["autodocs"],
  args: {
    children: "Active",
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Zinc: Story = {
  args: { tone: "zinc" },
};

export const Green: Story = {
  args: { tone: "green" },
};

export const Blue: Story = {
  args: { tone: "blue" },
};

export const Purple: Story = {
  args: { tone: "purple" },
};

export const AllTones: Story = {
  render: (args) => (
    <div className="flex flex-wrap gap-2">
      <Badge {...args} tone="zinc">
        Inactive
      </Badge>
      <Badge {...args} tone="green">
        Verified
      </Badge>
      <Badge {...args} tone="blue">
        Pending
      </Badge>
      <Badge {...args} tone="purple">
        Premium
      </Badge>
    </div>
  ),
};