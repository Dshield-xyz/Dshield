import Image from "next/image";
import { truncateMiddle } from "@/lib/format";

const EXPLORER_BASE = "https://stellar.expert/explorer/testnet/contract";
const CONTRACTS = [
  {
    label: "Shielded Pool",
    id: process.env.NEXT_PUBLIC_POOL_CONTRACT_ID,
  },
  {
    label: "Compliance",
    id: process.env.NEXT_PUBLIC_COMPLIANCE_CONTRACT_ID,
  },
];

const LINKS = [
  { label: "GitHub", href: "https://github.com/Dshield-xyz/Dshield" },
  { label: "Stellar", href: "https://stellar.org" },
  { label: "Noir", href: "https://noir-lang.org" },
];

const linkClass =
  "text-xs text-zinc-500 transition-colors hover:text-white";

export function Footer() {
  return (
    <footer className="mt-12 px-3 pb-3 sm:px-4 sm:pb-4">
      <div className="aurora-border mx-auto max-w-5xl rounded-2xl border border-zinc-800/80 bg-zinc-900/40 px-5 py-8 backdrop-blur-sm sm:px-8 sm:py-10">
        <div className="grid gap-6 sm:grid-cols-3 sm:gap-8">
          <div>
            <div className="flex items-center gap-2">
              <Image
                src="/dshield-mark.png"
                alt="DShield"
                width={22}
                height={24}
              />
              <h4 className="text-sm font-semibold text-white">DShield</h4>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              Private by Default. Compliant by Choice.
              <br />A shielded stablecoin wallet built on Stellar using
              Zero-Knowledge Proofs.
            </p>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-white">Contracts</h4>
            <ul className="mt-2 space-y-1.5">
              {CONTRACTS.map(
                ({ label, id }) =>
                  id && (
                    <li key={id}>
                      <a
                        href={`${EXPLORER_BASE}/${id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={linkClass}
                      >
                        {label}&ensp;
                        <span className="font-mono">
                          {truncateMiddle(id, 4, 4)}
                        </span>
                      </a>
                    </li>
                  ),
              )}
            </ul>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-white">Links</h4>
            <ul className="mt-2 space-y-1.5">
              {LINKS.map(({ label, href }) => (
                <li key={href}>
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-8 flex flex-col items-center gap-2 border-t border-zinc-800/50 pt-6">
          <p className="text-xs text-zinc-600">
            Built for{" "}
            <span className="text-zinc-400">Stellar Hacks: Real-World ZK</span>
          </p>
          <p className="text-xs text-zinc-700">
            Testnet demo only &mdash; unaudited. Not for production use.
          </p>
        </div>
      </div>
    </footer>
  );
}
