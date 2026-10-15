import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  turbopack: { root: path.dirname(fileURLToPath(import.meta.url)) },
  async headers() {
    const common = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
    ];
    return [
      {
        source: '/((?!mcp-app-sandbox\\.html).*)',
        headers: [...common, { key: 'X-Frame-Options', value: 'DENY' }],
      },
      {
        // The MCP Apps sandbox proxy: framed only by this app. The inner view
        // inherits this policy, so it can run its inline script and nothing
        // else: no network requests, no external scripts, styles or fonts.
        source: '/mcp-app-sandbox.html',
        headers: [
          ...common,
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'none'",
              "script-src 'unsafe-inline'",
              "style-src 'unsafe-inline'",
              'img-src data:',
              'font-src data:',
              'frame-src about:',
              "base-uri 'none'",
              "form-action 'none'",
              "frame-ancestors 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
