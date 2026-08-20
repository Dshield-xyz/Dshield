"use client";

import Link from "next/link";
import { useLayoutEffect, useState } from "react";
import { useWallet } from "@/components/WalletProvider";
import { getActiveNotes, getNotes } from "@/lib/notes";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  ShieldIcon,
  LockIcon,
  EyeSlashIcon,
  CheckBadgeIcon,
  ArrowDownIcon,
  ArrowRightIcon,
  BoltIcon,
  CodeIcon,
  GithubIcon,
} from "@/components/icons";

const GITHUB_URL = "https://github.com/tech-adrian/Dshield";

const TRUST = [
  { icon: LockIcon, label: "Proofs never leave your device" },
  { icon: BoltIcon, label: "Settles in seconds" },
  { icon: CodeIcon, label: "Open source" },
];

const HOW_IT_WORKS = [
  {
    step: "01",
    title: "Deposit",
    description:
      "Move USDC into the shielded pool, where it blends in with everyone else's. You keep a private note — your receipt and your key to the funds.",
    detail: "Your identity stays hidden",
  },
  {
    step: "02",
    title: "Withdraw",
    description:
      "When you're ready, DShield proves you own a note in the pool without revealing which one. The funds arrive at any address you choose, with no trace of where they came from.",
    detail: "Nothing connects the withdrawal to your deposit",
  },
  {
    step: "03",
    title: "Disclose on your terms",
    description:
      "Need to satisfy an auditor or regulator? Create a report that confirms exactly what you choose to share — and keeps everything else private.",
    detail: "Share only what you choose",
  },
];

const FEATURES = [
  {
    icon: EyeSlashIcon,
    title: "Hidden Balances",
    description:
      "Your balances and payment amounts stay between you and your recipient.",
  },
  {
    icon: ShieldIcon,
    title: "Unlinkable Withdrawals",
    description: "Funds arrive with no trace of where they came from.",
  },
  {
    icon: CheckBadgeIcon,
    title: "Compliance Ready",
    description:
      "Prove your funds are legitimate without handing over personal data.",
  },
  {
    icon: LockIcon,
    title: "Nothing Leaves Your Device",
    description:
      "Your keys and notes stay in your browser. No servers ever see them.",
  },
];

const JOURNEY = [
  {
    label: "Your Wallet",
    sub: "Where your USDC starts — and where you stay in control",
    color: "border-brand-500/30 bg-brand-950/20",
  },
  {
    label: "Proofs Made on Your Device",
    sub: "The evidence is created privately in your browser, never uploaded",
    color: "border-cyan-500/30 bg-cyan-950/20",
  },
  {
    label: "The Shielded Pool",
    sub: "Deposits blend together so no one can tell whose is whose",
    color: "border-violet-500/30 bg-violet-950/20",
  },
  {
    label: "On-Chain Verification",
    sub: "The network checks every proof before releasing a single cent",
    color: "border-purple-500/30 bg-purple-950/20",
  },
  {
    label: "Stellar Network",
    sub: "Settlement in seconds, for fractions of a cent",
    color: "border-zinc-500/30 bg-surface-card",
  },
];

/** Small uppercase eyebrow used above each section heading. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-center text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">
      {children}
    </p>
  );
}

export default function Home() {
  const { address, connect, isConnecting } = useWallet();
  const [noteCount, setNoteCount] = useState(0);
  const [activeCount, setActiveCount] = useState(0);

  /* eslint-disable react-hooks/set-state-in-effect */
  useLayoutEffect(() => {
    setNoteCount(getNotes().length);
    setActiveCount(getActiveNotes().length);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="relative mx-auto max-w-5xl px-4 pt-24 pb-12 text-center sm:px-6 sm:pt-36 sm:pb-20">
          <h1 className="animate-fade-up delay-100 text-balance text-4xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
            Private by Default.
            <br />
            <span className="bg-gradient-to-r from-brand-400 via-accent-400 to-brand-400 bg-clip-text text-transparent">
              Compliant by Choice.
            </span>
          </h1>
          <p className="animate-fade-up delay-200 mx-auto mt-5 max-w-2xl text-pretty text-base leading-relaxed text-ink-muted sm:mt-6 sm:text-lg">
            DShield is a shielded wallet for USDC on Stellar. Send and receive
            money without exposing your balance or history — and prove
            everything is in order whenever you choose to.
          </p>

          <div className="animate-fade-up delay-200 mt-10 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            {address ? (
              <Link href="/deposit" className={buttonVariants({ size: "lg" })}>
                Launch App
                <ArrowRightIcon className="h-4 w-4" />
              </Link>
            ) : (
              <Button size="lg" onClick={connect} disabled={isConnecting}>
                {isConnecting ? "Connecting..." : "Connect Wallet"}
                {!isConnecting && <ArrowRightIcon className="h-4 w-4" />}
              </Button>
            )}
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", size: "lg" })}
            >
              <GithubIcon className="h-4 w-4" />
              View on GitHub
            </a>
          </div>

          {/* Trust strip */}
          <div className="animate-fade-up delay-300 mt-10 flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
            {TRUST.map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="flex items-center gap-2 text-xs font-medium text-ink-subtle"
              >
                <Icon className="h-4 w-4 text-brand-400/80" />
                {label}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Note summary (if connected) */}
      {address && noteCount > 0 && (
        <section className="mx-auto max-w-5xl px-4 pb-8 sm:px-6">
          <Card border="brand">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-ink-muted">
                Your shielded notes
              </h3>
              <Link
                href="/withdraw"
                className="text-xs font-medium text-brand-400 transition-colors hover:text-brand-300"
              >
                Withdraw →
              </Link>
            </div>
            <div className="mt-3 flex gap-8 text-sm">
              <div>
                <span className="text-2xl font-bold text-ink-primary">
                  {activeCount}
                </span>
                <span className="ml-2 text-ink-subtle">available</span>
              </div>
              <div>
                <span className="text-2xl font-bold text-ink-faint">
                  {noteCount - activeCount}
                </span>
                <span className="ml-2 text-ink-subtle">withdrawn</span>
              </div>
            </div>
          </Card>
        </section>
      )}

      {/* Features grid */}
      <section className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <div key={title} className="scroll-reveal">
              <Card interactive className="h-full">
                <div className="inline-flex rounded-xl border border-brand-500/20 bg-brand-500/10 p-2.5">
                  <Icon className="h-5 w-5 text-brand-400" />
                </div>
                <h3 className="mt-4 text-sm font-semibold text-ink-primary">
                  {title}
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                  {description}
                </p>
              </Card>
            </div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="scroll-reveal">
          <Eyebrow>How it works</Eyebrow>
          <h2 className="mt-3 text-center text-3xl font-bold tracking-tight">
            Three Steps to Private Money
          </h2>
          <p className="mt-2 text-center text-sm text-ink-subtle">
            Deposit, withdraw, and prove what matters — in that order
          </p>
        </div>

        <div className="mt-12 space-y-2">
          {HOW_IT_WORKS.map(({ step, title, description, detail }, i) => (
            <div key={step} className="scroll-reveal">
              <Card interactive className="flex gap-4 p-4 sm:gap-6 sm:p-6">
                <div className="flex-shrink-0">
                  <span className="bg-gradient-to-b from-surface-interactive to-surface-raised bg-clip-text text-3xl font-bold text-transparent sm:text-4xl">
                    {step}
                  </span>
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-ink-primary">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-muted">
                    {description}
                  </p>
                  <p className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-brand-500/20 bg-brand-950/30 px-2.5 py-1 text-xs font-medium text-brand-300/90">
                    <ShieldIcon className="h-3.5 w-3.5" />
                    {detail}
                  </p>
                </div>
              </Card>
              {i < HOW_IT_WORKS.length - 1 && (
                <div className="flex justify-center py-1">
                  <ArrowDownIcon className="h-5 w-5 text-ink-faint" />
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* The journey of a shielded dollar */}
      <section className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-16">
        <div className="scroll-reveal">
          <Eyebrow>Under the hood</Eyebrow>
          <h2 className="mt-3 text-center text-3xl font-bold tracking-tight">
            The Journey of a Shielded Dollar
          </h2>
          <p className="mt-2 text-center text-sm text-ink-subtle">
            Every step between your wallet and the network is built to protect
            you
          </p>
        </div>

        <div className="mt-12 flex flex-col items-center gap-3">
          {JOURNEY.map(({ label, sub, color }, i, arr) => (
            <div key={label} className="scroll-reveal w-full max-w-md">
              <div
                className={`rounded-2xl border p-4 text-center backdrop-blur-sm transition-transform hover:scale-[1.02] ${color}`}
              >
                <p className="text-sm font-semibold text-ink-primary">{label}</p>
                <p className="mt-1 text-xs text-ink-muted">{sub}</p>
              </div>
              {i < arr.length - 1 && (
                <div className="flex justify-center py-1">
                  <ArrowDownIcon className="h-4 w-4 text-ink-faint" />
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-20">
        <div className="scroll-reveal">
          <div className="gradient-border rounded-3xl">
            <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-950/40 via-surface-card to-surface-card p-8 text-center sm:p-12">
              <div
                className="absolute inset-x-0 -top-24 -z-0 mx-auto h-48 w-48 rounded-full bg-brand-500/20 blur-3xl"
                aria-hidden="true"
              />
              <div className="relative">
                <h2 className="text-3xl font-bold tracking-tight">
                  Ready to go private?
                </h2>
                <p className="mx-auto mt-3 max-w-md text-sm text-ink-muted">
                  Connect your wallet and shield your first deposit in seconds.
                  Free to try on testnet.
                </p>
                <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
                  <Link
                    href="/deposit"
                    className={buttonVariants({ size: "lg" })}
                  >
                    Deposit
                  </Link>
                  <Link
                    href="/withdraw"
                    className={buttonVariants({ variant: "outline", size: "lg" })}
                  >
                    Withdraw
                  </Link>
                  <Link
                    href="/compliance"
                    className={buttonVariants({ variant: "outline", size: "lg" })}
                  >
                    Compliance
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
