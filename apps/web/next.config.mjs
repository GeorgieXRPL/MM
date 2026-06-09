/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    '@solana/web3.js',
    'better-sqlite3',
    'jito-ts',
    '@meteora-ag/dlmm',
    '@raydium-io/raydium-sdk-v2',
    '@orca-so/whirlpools-sdk',
    '@pump-fun/pump-swap-sdk',
    '@ellipsis-labs/phoenix-sdk',
    'pino',
    'pino-pretty',
    'thread-stream',
  ],
  reactStrictMode: true,
  transpilePackages: ['@amm/core', '@amm/shared', '@amm/strategies', '@amm/venues', '@amm/orchestrator'],
  // Tell webpack to resolve `.js` ESM-style imports back to `.ts`/`.tsx` on disk
  // so we can keep NodeNext-style imports inside our local source.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
