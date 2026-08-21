import type { Meta, StoryObj } from "@storybook/react";

import { Card, CardLabel } from "./Card";

const meta = {
  title: "UI/Card",
  component: Card,
  tags: ["autodocs"],
  args: {
    children: "Card content goes here.",
  },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const BrandBorder: Story = {
  args: {
    border: "brand",
  },
};

export const Interactive: Story = {
  args: {
    interactive: true,
  },
};

export const PaddingNone: Story = {
  args: {
    padding: "none",
  },
};

export const PaddingSm: Story = {
  args: {
    padding: "sm",
  },
};

export const WithLabel: Story = {
  render: (args) => (
    <Card {...args}>
      <CardLabel>Balances</CardLabel>
      <p className="mt-3">This card uses the CardLabel section heading.</p>
    </Card>
  ),
};