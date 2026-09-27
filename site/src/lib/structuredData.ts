import type { Post } from './posts';
import { links, url } from './links';

/** A schema.org JSON-LD object. */
export type JsonLd = Record<string, unknown>;

const SITE_NAME = 'Db2 for i MCP Server';

/** Absolute URL for a path on this site. */
function abs(path: string, site: URL): string {
  return new URL(url(path), site).href;
}

function organization(site: URL): JsonLd {
  return {
    '@type': 'Organization',
    '@id': `${abs('/', site)}#organization`,
    name: 'Strom Capital',
    url: 'https://github.com/Strom-Capital',
  };
}

/** Home page: the site, the software and who maintains it. */
export function homeJsonLd(site: URL): JsonLd {
  const home = abs('/', site);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      organization(site),
      {
        '@type': 'WebSite',
        '@id': `${home}#website`,
        url: home,
        name: SITE_NAME,
        publisher: { '@id': `${home}#organization` },
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${home}#software`,
        name: SITE_NAME,
        alternateName: 'mcp-server-db2i',
        description:
          'An open-source Model Context Protocol (MCP) server that lets Claude, Cursor and other AI assistants read IBM Db2 for i. Read-only by design, with a library allowlist, column masking, OAuth sign-in and an audit log.',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Linux, macOS, Windows',
        url: home,
        image: abs('/og.png', site),
        license: 'https://opensource.org/licenses/MIT',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        codeRepository: links.github,
        downloadUrl: links.npm,
        softwareHelp: links.docs,
        sameAs: [links.github, links.npm],
        author: { '@id': `${home}#organization` },
      },
    ],
  };
}

/** Blog post page. */
export function postJsonLd(post: Post, site: URL): JsonLd {
  const postUrl = abs(`/blog/${post.id}/`, site);
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    '@id': `${postUrl}#post`,
    mainEntityOfPage: postUrl,
    url: postUrl,
    headline: post.data.title,
    description: post.data.description,
    datePublished: post.data.date.toISOString(),
    image: abs('/og.png', site),
    keywords: post.data.tags.length ? post.data.tags.join(', ') : undefined,
    inLanguage: 'en',
    author: organization(site),
    publisher: organization(site),
    isPartOf: { '@type': 'Blog', '@id': `${abs('/blog/', site)}#blog`, name: `${SITE_NAME} blog`, url: abs('/blog/', site) },
  };
}

/** Serialize for a `<script type="application/ld+json">` tag. */
export function serializeJsonLd(data: JsonLd): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
