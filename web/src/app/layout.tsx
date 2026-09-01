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
  /*
   * Lets the page draw under the notch and the home indicator, which is what
   * makes `env(safe-area-inset-bottom)` report anything but 0. The tab bar and
   * the speaker sheet both budget for it: without this they would be laid out
   * as if the indicator were not there and then have it drawn over them.
   */
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${outfit.variable} ${jakarta.variable} h-full antialiased`}
    >
      {/*
       * Above 900px the app is locked to the viewport and its panels scroll
       * internally — the two-column layout only reads as one instrument panel if
       * it fits on screen. Below that the page scrolls normally and ends behind
       * a fixed tab bar, so it has to reserve that bar's height at the bottom or
       * the last row of whichever tab is open is unreachable.
       */}
      <body className="flex min-h-full flex-col items-center max-[900px]:pb-[calc(var(--tab-bar)+env(safe-area-inset-bottom))] min-[901px]:h-screen min-[901px]:overflow-hidden">
        {children}
        {/*
         * `mobileOffset` covers sonner's own 600px breakpoint and `offset` the
         * rest; both read the same responsive token, so the toast clears the tab
         * bar at every width the bar exists at. See `--toast-bottom`.
         */}
        <Toaster
          position="bottom-right"
          offset={{ bottom: "var(--toast-bottom)" }}
          mobileOffset={{ bottom: "var(--toast-bottom)", left: "16px", right: "16px" }}
        />
      </body>
    </html>
  );
}
