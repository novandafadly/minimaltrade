/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@idx/domain", "@idx/db", "@idx/config"],
  webpack: (config) => {
    // @idx/* workspace packages use TS-native ".js"-suffixed relative
    // imports (e.g. "./env.js" for "./env.ts") — valid under
    // moduleResolution "Bundler" and what `tsc` expects, but webpack's
    // resolver doesn't map that suffix back to .ts/.tsx source files on its
    // own when transpiling those packages directly from source (no dist
    // build step in this monorepo). This tells webpack to try .ts/.tsx
    // first whenever a ".js" specifier is requested, matching tsc's own
    // resolution so we don't have to touch those packages' source.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"]
    };
    return config;
  }
};
export default nextConfig;
