import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./mobile-overrides.css";
import "./organized-mobile.css";
import { PwaRegister } from "@/components/pwa-register";

export const metadata: Metadata = {
  title: "Territory",
  description: "Sports trivia that changes the map.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Territory" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#F2EFE4",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <PwaRegister />
      </body>
    </html>
  );
}
