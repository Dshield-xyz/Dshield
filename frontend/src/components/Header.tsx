"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as StellarSdk from "@stellar/stellar-sdk";
import { useWallet } from "./WalletProvider";
import { Button } from "./ui/Button";
import { MenuIcon, CloseIcon } from "./icons";
import { truncateMiddle } from "@/lib/format";
import { cn } from "@/lib/cn";
import { getRpcServer, queryContract, getUsdcSacId } from "@/lib/stellar";

const NAV_ITEMS = [
  { href: "/deposit", label: "Deposit" },
  { href: "/withdraw", label: "Withdraw" },
  { href: "/compliance", label: "Compliance" },
  { href: "/audit", label: "Audit" },
  { href: "/history", label: "History" },
];

interface Balances {
  xlm: string;
  usdc: string;
}

async function fetchBalances(address: string): Promise<Balances> {
  const server = getRpcServer();

  const accountKey = StellarSdk.xdr.LedgerKey.account(
    new StellarSdk.xdr.LedgerKeyAccount({
      accountId: StellarSdk.Keypair.fromPublicKey(address).xdrAccountId(),
    }),
  );

  const [ledger, usdcVal] = await Promise.all([
    server.getLedgerEntries(accountKey).catch(() => null),
    (async () => {
      const sacId = getUsdcSacId();
      if (!sacId) return null;
      return queryContract(sacId, "balance", [
        StellarSdk.nativeToScVal(address, { type: "address" }),
      ]);
    })(),
  ]);

  let xlm = "0.0000";
  if (ledger && ledger.entries.length > 0) {
    const stroops = ledger.entries[0].val.account().balance();
    xlm = (Number(stroops) / 1e7).toFixed(4);
  }

  let usdc = "0.00";
  if (usdcVal) {
    const raw = BigInt(StellarSdk.scValToNative(usdcVal) as string | number);
    usdc = (Number(raw) / 1e7).toFixed(2);
  }

  return { xlm, usdc };
}

export function Header() {
  const { address, connect, disconnect, isConnecting } = useWallet();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const isLanding = pathname === "/";
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let lastY = window.scrollY;
    function onScroll() {
      const y = window.scrollY;
      setHidden(y > lastY && y > 80);
      lastY = y;
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- loading state must
   * flip true synchronously when the dropdown opens, before the async
   * fetch resolves, so the UI shows a loading state immediately. */
  useEffect(() => {
    if (!balanceOpen || !address) return;
    setLoadingBalances(true);
    fetchBalances(address)
      .then(setBalances)
      .catch(() => setBalances(null))
      .finally(() => setLoadingBalances(false));
  }, [balanceOpen, address]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!balanceOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setBalanceOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [balanceOpen]);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 px-3 pt-3 sm:px-4 sm:pt-4 transition-transform duration-300",
        hidden && "-translate-y-full",
      )}
    >
      <div className="aurora-border mx-auto max-w-5xl rounded-2xl border border-zinc-800/80 bg-zinc-950/70 shadow-lg shadow-black/20 backdrop-blur-xl">
        <div className="flex h-14 items-center justify-between px-3 sm:px-4">
          {/* Logo */}
          <Link
            href="/"
            className="flex items-center gap-2 text-lg font-bold text-white"
          >
            <Image
              src="/dshield-mark.png"
              alt="DShield"
              width={25}
              height={28}
              priority
            />
            <span className="hidden xs:inline">DShield</span>
          </Link>

          {/* Landing page: live-status pill sits where the nav would be */}
          {isLanding && (
            <div className="hidden items-center gap-2.5 rounded-full border border-brand-500/25 bg-brand-500/10 px-3.5 py-1.5 text-xs font-medium text-brand-200 sm:inline-flex">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
              </span>
              Live on Stellar Testnet
            </div>
          )}

          {/* Desktop nav — hidden on landing page */}
          {!isLanding && (
            <nav className="hidden gap-1 md:flex">
              {NAV_ITEMS.map(({ href, label }) => (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    "rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    pathname === href
                      ? "bg-zinc-800 text-white"
                      : "text-zinc-400 hover:bg-zinc-800/50 hover:text-white",
                  )}
                >
                  {label}
                </Link>
              ))}
            </nav>
          )}

          <div className="flex items-center gap-2">
            {/* Wallet */}
            {address ? (
              <div className="flex items-center gap-2">
                {/* Clickable address pill with balance dropdown */}
                <div className="relative hidden sm:block" ref={dropdownRef}>
                  <button
                    onClick={() => setBalanceOpen((o) => !o)}
                    aria-expanded={balanceOpen}
                    aria-haspopup="true"
                    className="focus-ring rounded-full bg-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white"
                  >
                    {truncateMiddle(address, 4, 4)}
                  </button>

                  {balanceOpen && (
                    <div className="absolute right-0 top-full mt-2 w-48 rounded-xl border border-zinc-800 bg-zinc-950 p-3 shadow-xl shadow-black/40">
                      <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                        Balances
                      </p>
                      {loadingBalances ? (
                        <p className="text-xs text-zinc-500">Loading…</p>
                      ) : balances ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-zinc-400">XLM</span>
                            <span className="font-mono text-xs text-white">
                              {balances.xlm}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-zinc-400">USDC</span>
                            <span className="font-mono text-xs text-white">
                              {balances.usdc}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs text-zinc-500">Unavailable</p>
                      )}
                      <div className="mt-3 border-t border-zinc-800 pt-2">
                        <button
                          onClick={() => { disconnect(); setBalanceOpen(false); }}
                          className="w-full text-left text-xs text-zinc-500 transition-colors hover:text-red-400"
                        >
                          Disconnect
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={disconnect}
                  className="text-zinc-500 sm:hidden"
                >
                  Disconnect
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                onClick={connect}
                disabled={isConnecting}
                className="sm:px-4 sm:py-2 sm:text-sm"
              >
                {isConnecting ? "Connecting..." : "Connect Wallet"}
              </Button>
            )}

            {/* Mobile hamburger — hidden on landing page */}
            {!isLanding && (
              <button
                onClick={() => setMobileOpen(!mobileOpen)}
                aria-expanded={mobileOpen}
                className="focus-ring flex items-center justify-center rounded-lg p-2 text-zinc-400 transition-colors hover:text-white md:hidden"
                aria-label="Toggle menu"
              >
                {mobileOpen ? (
                  <CloseIcon className="h-5 w-5" />
                ) : (
                  <MenuIcon className="h-5 w-5" />
                )}
              </button>
            )}
          </div>
        </div>

        {/* Mobile nav dropdown — hidden on landing page */}
        {!isLanding && mobileOpen && (
          <nav className="border-t border-zinc-800 px-3 py-3 md:hidden">
            <div className="flex flex-col gap-1">
              {NAV_ITEMS.map(({ href, label }) => (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                    pathname === href
                      ? "bg-zinc-800 text-white"
                      : "text-zinc-400 hover:bg-zinc-800/50 hover:text-white",
                  )}
                >
                  {label}
                </Link>
              ))}
            </div>
            {address && (
              <div className="mt-2 border-t border-zinc-800/50 pt-2">
                <span className="block rounded-lg px-3 py-2 font-mono text-xs text-zinc-500">
                  {truncateMiddle(address, 8, 8)}
                </span>
              </div>
            )}
          </nav>
        )}
      </div>
    </header>
  );
}
