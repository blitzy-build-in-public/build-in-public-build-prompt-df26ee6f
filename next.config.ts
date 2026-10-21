import type { NextConfig } from 'next';

// No Content-Security-Policy is set on purpose: Next.js needs inline bootstrap scripts, so a
// static policy would either break hydration or degrade to 'unsafe-inline', and the generated
// draft is rendered as text, which already removes the cross-site-scripting surface a CSP covers.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
