/** External links used across the site. Change the docs origin here. */
export const DOCS = 'https://docs.db2i-mcp.com';
export const GITHUB = 'https://github.com/Strom-Capital/mcp-server-db2i';

export const links = {
  docs: DOCS,
  quickstart: `${DOCS}/quickstart`,
  clientSetup: `${DOCS}/client-setup`,
  tools: `${DOCS}/tools`,
  configuration: `${DOCS}/configuration`,
  multipleSystems: `${DOCS}/configuration#multiple-systems`,
  mapepire: `${DOCS}/configuration#using-the-mapepire-driver-ssh`,
  drivers: `${DOCS}/configuration#database-drivers`,
  customTools: `${DOCS}/custom-tools`,
  security: `${DOCS}/security`,
  allowlist: `${DOCS}/security#schema-allowlist`,
  masking: `${DOCS}/security#column-masking`,
  auditLog: `${DOCS}/security#audit-log`,
  httpTransport: `${DOCS}/http-transport`,
  oauth: `${DOCS}/http-transport#remote-clients-oauth`,
  docker: `${DOCS}/docker`,
  useCases: `${DOCS}/use-cases`,
  github: GITHUB,
  issues: `${GITHUB}/issues`,
  newIssue: `${GITHUB}/issues/new`,
  changelog: `${GITHUB}/blob/main/CHANGELOG.md`,
  releases: `${GITHUB}/releases`,
  sponsor: 'https://github.com/sponsors/Strom-Capital',
  npm: 'https://www.npmjs.com/package/mcp-server-db2i',
  registry: 'https://registry.modelcontextprotocol.io/',
  mcp: 'https://modelcontextprotocol.io/',
  ibmMcp: 'https://github.com/IBM/ibmi-mcp-server',
} as const;

/** A path inside this site, with the configured base. */
export function url(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 26 September 2026 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
