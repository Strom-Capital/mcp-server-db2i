/**
 * npm packages behind the non-default drivers.
 *
 * `node-jt400`, `@ibm/mapepire-js` and `ssh2` are optional peer dependencies,
 * so npm and npx do not install them. A system that selects one of these
 * drivers is checked at startup, and the driver's own import failure gives the
 * same instructions.
 */

import type { DbDriverName } from '../config.js';

/** Packages each driver imports that a default install leaves out. */
export const DRIVER_PACKAGES: Readonly<Record<DbDriverName, readonly string[]>> = {
  odbc: [],
  jt400: ['node-jt400'],
  mapepire: ['@ibm/mapepire-js', 'ssh2'],
};

const DRIVER_NOTES: Readonly<Record<DbDriverName, string>> = {
  odbc: '',
  jt400:
    'node-jt400 builds a Java bridge when it installs, so a JDK must be present then, and a Java runtime (JRE 11 or later) when the server runs.',
  mapepire: 'Nothing else is needed on this machine. The IBM i needs SSH access and Java 8 or later.',
};

/** A system whose driver packages are not installed. */
export interface MissingDriverPackages {
  driver: DbDriverName;
  packages: string[];
  /** Profile names from DB2I_PROFILES, empty for a single-system setup. */
  systems: string[];
}

/** Resolves a bare specifier without loading it; throws when it is not installed. */
export type PackageResolver = (specifier: string) => void;

const resolveFromHere: PackageResolver = (specifier) => {
  import.meta.resolve(specifier);
};

/**
 * The drivers in use whose packages are missing, grouped by driver.
 * Resolving does not import the package, so no JVM starts here.
 */
export function findMissingDriverPackages(
  systems: readonly { name: string; driver: DbDriverName }[],
  options: { profiles: boolean; resolve?: PackageResolver }
): MissingDriverPackages[] {
  const resolve = options.resolve ?? resolveFromHere;
  const byDriver = new Map<DbDriverName, MissingDriverPackages>();
  for (const system of systems) {
    let entry = byDriver.get(system.driver);
    if (!entry) {
      const packages = DRIVER_PACKAGES[system.driver].filter((specifier) => {
        try {
          resolve(specifier);
          return false;
        } catch {
          return true;
        }
      });
      if (packages.length === 0) {
        continue;
      }
      entry = { driver: system.driver, packages, systems: [] };
      byDriver.set(system.driver, entry);
    }
    if (options.profiles) {
      entry.systems.push(system.name);
    }
  }
  return [...byDriver.values()];
}

/**
 * What to run to add a driver's packages, for npx and for an npm install.
 */
export function driverInstallHelp(driver: DbDriverName, packages: readonly string[] = DRIVER_PACKAGES[driver]): string {
  const npxPackages = packages.map((name) => `-p ${name}`).join(' ');
  const args = ['-y', '-p', 'mcp-server-db2i@latest', ...packages.flatMap((name) => ['-p', name]), 'mcp-server-db2i']
    .map((arg) => JSON.stringify(arg))
    .join(', ');
  const lines = [
    `The ${driver} driver needs ${packages.join(' and ')}, which ${packages.length === 1 ? 'is' : 'are'} not installed by default.`,
    '',
    `With npx, add ${packages.length === 1 ? 'it' : 'them'} to the same command:`,
    `  npx -y -p mcp-server-db2i@latest ${npxPackages} mcp-server-db2i`,
    '',
    `  In a client config: "command": "npx", "args": [${args}]`,
    '',
    `With npm, install ${packages.length === 1 ? 'it' : 'them'} next to the server (leave out -g in a project):`,
    `  npm install -g mcp-server-db2i ${packages.join(' ')}`,
  ];
  const note = DRIVER_NOTES[driver];
  if (note) {
    lines.push('', note);
  }
  lines.push('', 'Docs: https://docs.db2i-mcp.com/configuration#database-drivers');
  return `${lines.join('\n')}\n`;
}

/** Startup message for missing driver packages. */
export function missingDriverPackagesMessage(missing: readonly MissingDriverPackages[]): string {
  return missing
    .map((entry) => {
      const where =
        entry.systems.length > 0
          ? `DB2I_PROFILES: ${entry.systems.map((name) => `"${name}"`).join(', ')} ${entry.systems.length === 1 ? 'uses' : 'use'} driver ${entry.driver}.`
          : `DB2I_DRIVER=${entry.driver}.`;
      return `${where}\n${driverInstallHelp(entry.driver, entry.packages)}`;
    })
    .join('\n');
}
