import type { Meta, StoryObj } from "@storybook/react";

import { PageShell, PageHeader } from "./Page";

const meta = {
  title: "UI/PageShell",
  component: PageShell,
  tags: ["autodocs"],
  args: {
    children: (
      <p className="text-zinc-400">
        This is the page content area. It is centered with responsive padding.
      </p>
    ),
  },
} satisfies Meta<typeof PageShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Narrow: Story = {
  args: {
    width: "narrow",
  },
};

export const Wide: Story = {
  args: {
    width: "wide",
  },
};

export const WithHeader: Story = {
  render: (args) => (
    <PageShell {...args}>
      <PageHeader
        title="Deposit"
        description="Shield your USDC by depositing it into the DShield pool."
      />
      <p className="mt-6 text-zinc-400">Deposit form goes here.</p>
    </PageShell>
  ),
};