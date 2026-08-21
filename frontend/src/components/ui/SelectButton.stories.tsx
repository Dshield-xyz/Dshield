import type { Meta, StoryObj } from "@storybook/react";

import { SelectButton } from "./SelectButton";

const meta = {
  title: "UI/SelectButton",
  component: SelectButton,
  tags: ["autodocs"],
  args: {
    children: "100 USDC",
  },
} satisfies Meta<typeof SelectButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unselected: Story = {
  args: {
    selected: false,
  },
};

export const SelectedAccent: Story = {
  args: {
    selected: true,
    tone: "accent",
  },
};

export const SelectedWhite: Story = {
  args: {
    selected: true,
    tone: "white",
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};

export const DenominationPicker: Story = {
  render: (args) => (
    <div className="grid grid-cols-3 gap-2">
      <SelectButton {...args} selected={false}>
        10 USDC
      </SelectButton>
      <SelectButton {...args} selected={true}>
        100 USDC
      </SelectButton>
      <SelectButton {...args} selected={false}>
        1,000 USDC
      </SelectButton>
    </div>
  ),
};