import { describe, it, expect } from "vitest";
import {
  formatReportText,
  formatActivityCsv,
  formatActivityJson,
  type ComplianceReport,
  type ActivityItem,
} from "./report";

const base: ComplianceReport = {
  network: "Testnet",
  poolId: "CABC",
  commitment: "0xdeadbeef",
  nullifierHash: "0x00aa",
  integrityOk: true,
  depositConfirmed: true,
  leafIndex: 9,
  withdrawn: true,
  depositTx: { hash: "abc123", at: "2026-06-26T00:00:00Z" },
  withdrawTx: { hash: "def456", at: "2026-06-26T01:00:00Z" },
  generatedAt: 0,
};

describe("formatReportText", () => {
  it("includes the key on-chain facts", () => {
    const t = formatReportText(base);
    expect(t).toContain("DShield Compliance Report");
    expect(t).toContain("leaf #9");
    expect(t).toContain("Withdrawn");
    expect(t).toContain(base.commitment);
    expect(t).toContain("abc123");
  });

  it("never leaks an amount, address, or the spendable note", () => {
    const t = formatReportText(base).toLowerCase();
    expect(t).not.toContain("usdc");
    expect(t).not.toContain("amount");
    // The exported report must not carry the bearer-spendable note secret
    // (serialized notes are prefixed "dshield-v1-") — sharing the report
    // with a third party (e.g. an auditor) would otherwise let them drain
    // the note.
    expect(t).not.toContain("dshield-v1-");
  });

  it("renders the unconfirmed / unspent / no-tx case", () => {
    const t = formatReportText({
      ...base,
      depositConfirmed: false,
      leafIndex: null,
      withdrawn: false,
      depositTx: null,
      withdrawTx: null,
    });
    expect(t).toContain("Not found on-chain");
    expect(t).toContain("In pool (unspent)");
    expect(t).toContain("Deposit tx          n/a");
  });
});

const activity: ActivityItem[] = [
  {
    type: "deposit",
    timestamp: 1750000000000,
    commitment: "0xdeposit1",
    amount: "1000000000",
    poolId: "CPOOL1",
  },
  {
    type: "withdrawal",
    timestamp: 1750000001000,
    commitment: "0xdeposit1",
    amount: "1000000000",
    poolId: "CPOOL1",
  },
  {
    type: "compliance",
    timestamp: 1750000002000,
    commitment: "0xkychash, with a comma",
    amount: "0",
  },
];

describe("formatActivityCsv", () => {
  it("emits a header row followed by one row per item", () => {
    const csv = formatActivityCsv(activity);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "type,date,amount_usdc,amount_stroops,commitment,pool_id",
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(
      `deposit,${new Date(1750000000000).toISOString()},100,1000000000,0xdeposit1,CPOOL1`,
    );
  });

  it("leaves amount and pool_id blank for compliance rows", () => {
    const csv = formatActivityCsv(activity);
    const complianceLine = csv.split("\n")[3];
    expect(complianceLine.startsWith("compliance,")).toBe(true);
    expect(complianceLine).toContain(",,,");
  });

  it("quotes and escapes fields containing commas", () => {
    const csv = formatActivityCsv(activity);
    expect(csv).toContain('"0xkychash, with a comma"');
  });
});

describe("formatActivityJson", () => {
  it("round-trips as valid JSON with one object per item", () => {
    const parsed = JSON.parse(formatActivityJson(activity));
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({
      type: "deposit",
      amountUsdc: "100",
      amountStroops: "1000000000",
      commitment: "0xdeposit1",
      poolId: "CPOOL1",
    });
  });

  it("nulls amount and poolId for compliance rows", () => {
    const parsed = JSON.parse(formatActivityJson(activity));
    const compliance = parsed[2];
    expect(compliance.amountUsdc).toBeNull();
    expect(compliance.amountStroops).toBeNull();
    expect(compliance.poolId).toBeNull();
  });
});
