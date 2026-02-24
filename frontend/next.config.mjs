/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    proxyTimeout: 300_000, // 5 min — Claude Code calls can take 2+ min
  },
  async rewrites() {
    const apiPort = process.env.NEXT_PUBLIC_API_PORT || '3001';
    return [
      {
        source: "/api/:path*",
        destination: `http://localhost:${apiPort}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
