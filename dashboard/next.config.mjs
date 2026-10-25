/** @type {import('next').NextConfig} */
const nextConfig = {
  // Only matters for `npm run dev` opened by IP (the server runs `./dev.sh --prod`, which doesn't need it).
  // Next blocks cross-origin dev requests by default. 209.182.234.33 = server, 192.168.1.67 = the Pi.
  allowedDevOrigins: ['209.182.234.33', '192.168.1.67'],
};

export default nextConfig;
