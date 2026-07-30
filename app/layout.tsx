import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./mobile-overrides.css";

export const metadata: Metadata = {
  title: "Territory",
  description: "Sports trivia that changes the map.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#F2EFE4",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
