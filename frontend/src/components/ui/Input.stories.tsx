import type { Meta, StoryObj } from "@storybook/react";

import { Input } from "./Input";

const meta = {
  title: "UI/Input",
  component: Input,
  tags: ["autodocs"],
  args: {
    placeholder: "G…",
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithLabel: Story = {
  args: {
    label: "Beneficiary address",
  },
};

export const WithHint: Story = {
  args: {
    label: "Amount",
    hint: "Entered as a string of stroops (1 XLM = 10,000,000).",
  },
};

export const Monospace: Story = {
  args: {
    label: "Shielded note",
    mono: true,
    placeholder: "dshield-v1-…",
  },
};

export const Invalid: Story = {
  args: {
    label: "Address",
    defaultValue: "not-an-address",
    className: "border-red-500/60",
  },
};