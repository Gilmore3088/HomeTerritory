import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Dev-only: lets phones on the local network load dev assets when the
  // server runs with -H 0.0.0.0 (e.g. LAN playtests). Ignored by next build.
  allowedDevOrigins: process.env.LAN_DEV_ORIGIN ? [process.env.LAN_DEV_ORIGIN] : [],
};

export default nextConfig;
