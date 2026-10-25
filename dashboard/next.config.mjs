/** @type {import('next').NextConfig} */
const nextConfig = {
  // The dashboard is served from the server (the Pi, 192.168.1.67) and opened by IP from
  // other machines on the LAN. Next blocks cross-origin dev requests by default.
  allowedDevOrigins: ['192.168.1.67'],
};

export default nextConfig;
