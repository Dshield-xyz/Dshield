import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/components/WalletProvider";
import { Background } from "@/components/Background";
import { ShieldField } from "@/components/ShieldField";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { ToastProvider } from "@/components/ui/Toast";
import { useState, useEffect } from "react";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://dshield.vercel.app"),
  title: {
    default: "DShield — Shielded Stablecoin Wallet",
    template: "%s · DShield",
  },
  description:
    "Private by Default. Compliant by Choice. A shielded USDC wallet on Stellar using Zero-Knowledge Proofs.",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
    apple: "/icon.png",
  },
  openGraph: {
    title: "DShield - Shielded Stablecoin Wallet",
    description:
      "Private USDC payments on Stellar with Zero-Knowledge Proofs. Compliant selective disclosure built in.",
    images: [{ url: "/dshield.png", width: 800, height: 800 }],
  },
  twitter: {
    card: "summary",
    title: "DShield",
    description:
      "Private by Default. Compliant by Choice. Shielded USDC on Stellar.",
    images: ["/dshield.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const [bannerDismissed, setBannerDismissed] = useState(false);

  useEffect(() => {
    const dismissed = localStorage.getItem("testnetBannerDismissed");
    if (dismissed) {
      setBannerDismissed(true);
    }
  }, []);

  const handleDismiss = () => {
    setBannerDismissed(true);
    localStorage.setItem("testnetBannerDismissed", "true");
  };

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-zinc-950 text-white">
        <Background />
        {/* Live constellation, present on every page — fixed to the viewport
            (not the document) so it never scrolls away on tall pages, and
            vignetted so it reads as ambient texture behind forms and cards
            rather than competing with them. */}
        <ShieldField className="pointer-events-none fixed inset-0 -z-10 h-full w-full opacity-70 [mask-image:radial-gradient(52rem_34rem_at_50%_0%,black,transparent_72%)]" />
        <WalletProvider>
          <ToastProvider>
            {!bannerDismissed && (
              <div className="w-full bg-amber-500/10 border-b border-amber-500/30 px-4 py-3">
                <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
                  <p className="text-sm text-amber-200">
                    <span className="font-semibold">⚠️ Testnet demo only — unaudited.</span> Do not use with real funds.
                  </p>
                  <button
                    onClick={handleDismiss}
                    className="text-amber-200 hover:text-amber-100 text-sm font-medium"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            <Header />
            <main className="flex-1">{children}</main>
            <Footer />
          </ToastProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
