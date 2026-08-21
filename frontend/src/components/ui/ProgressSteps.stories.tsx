import type { Meta, StoryObj } from "@storybook/react";

import { ProgressSteps } from "./ProgressSteps";

const STEPS = ["deposit", "shield", "confirm"] as const;

const meta = {
  title: "UI/ProgressSteps",
  component: ProgressSteps,
  tags: ["autodocs"],
  args: {
    label: "Depositing…",
    steps: STEPS,
    current: "shield",
  },
} satisfies Meta<typeof ProgressSteps>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FirstStep: Story = {
  args: {
    current: "deposit",
  },
};

export const MiddleStep: Story = {
  args: {
    current: "shield",
  },
};

export const LastStep: Story = {
  args: {
    current: "confirm",
  },
};

export const LongFlow: Story = {
  args: {
    label: "Processing…",
    steps: ["init", "connect", "approve", "sign", "finalize"] as const,
    current: "approve",
  },
};