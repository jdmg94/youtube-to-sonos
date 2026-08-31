import type { Metadata, Viewport } from "next";
import { Outfit, Plus_Jakarta_Sans } from "next/font/google";

import { Toaster } from "@/components/ui/sonner";

import "./globals.css";

/*
 * The original UI pulled these from the Google Fonts CDN with a <link>. Loading
 * them through next/font self-hosts the files and inlines the @font-face rules,
 * which removes a third-party request from the critical path — and, since this
 * is a LAN appliance, removes a dependency on the internet being up at all.
 */
const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  weight: ["300", "400", "600", "800"],
  display: "swap",
});

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["300", "400", "500", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "YouTube ➔ Sonos Streamer",
  description: "Play YouTube audio on your Sonos speakers.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0f19",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${outfit.variable} ${jakarta.variable} h-full antialiased`}
    >
      {/*
       * Above 900px the app is locked to the viewport and its panels scroll
       * internally — the bento layout only reads as one instrument panel if it
       * fits on screen. Below that there is no room for that trick, so the lock
       * is lifted and the page scrolls normally.
       */}
      <body className="flex min-h-full flex-col items-center min-[901px]:h-screen min-[901px]:overflow-hidden">
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
