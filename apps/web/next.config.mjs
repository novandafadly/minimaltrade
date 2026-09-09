/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@idx/domain", "@idx/db", "@idx/config"]
};
export default nextConfig;
