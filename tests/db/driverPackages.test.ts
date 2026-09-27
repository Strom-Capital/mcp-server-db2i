import { describe, expect, it, vi } from 'vitest';

import {
  driverInstallHelp,
  findMissingDriverPackages,
  missingDriverPackagesMessage,
  type PackageResolver,
} from '../../src/db/driverPackages.js';

/** A resolver that finds only the named packages. */
function installed(...names: string[]): PackageResolver {
  return vi.fn((specifier: string) => {
    if (!names.includes(specifier)) {
      throw new Error(`Cannot find package '${specifier}'`);
    }
  });
}

describe('findMissingDriverPackages', () => {
  it('checks nothing for odbc', () => {
    const resolve = installed();
    expect(findMissingDriverPackages([{ name: 'default', driver: 'odbc' }], { profiles: false, resolve })).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reports node-jt400 for jt400', () => {
    const missing = findMissingDriverPackages([{ name: 'default', driver: 'jt400' }], {
      profiles: false,
      resolve: installed('ssh2'),
    });
    expect(missing).toEqual([{ driver: 'jt400', packages: ['node-jt400'], systems: [] }]);
  });

  it('reports only the mapepire packages that are missing', () => {
    const missing = findMissingDriverPackages([{ name: 'default', driver: 'mapepire' }], {
      profiles: false,
      resolve: installed('ssh2'),
    });
    expect(missing).toEqual([{ driver: 'mapepire', packages: ['@ibm/mapepire-js'], systems: [] }]);
  });

  it('passes when the packages are installed', () => {
    const missing = findMissingDriverPackages(
      [
        { name: 'prod', driver: 'jt400' },
        { name: 'test', driver: 'mapepire' },
      ],
      { profiles: true, resolve: installed('node-jt400', '@ibm/mapepire-js', 'ssh2') }
    );
    expect(missing).toEqual([]);
  });

  it('groups profiles by driver and resolves each driver once', () => {
    const resolve = installed();
    const missing = findMissingDriverPackages(
      [
        { name: 'prod', driver: 'jt400' },
        { name: 'erp', driver: 'odbc' },
        { name: 'test', driver: 'jt400' },
      ],
      { profiles: true, resolve }
    );
    expect(missing).toEqual([{ driver: 'jt400', packages: ['node-jt400'], systems: ['prod', 'test'] }]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('finds packages installed next to the server by default', () => {
    // The dev install has every driver package.
    const missing = findMissingDriverPackages(
      [
        { name: 'a', driver: 'jt400' },
        { name: 'b', driver: 'mapepire' },
      ],
      { profiles: true }
    );
    expect(missing).toEqual([]);
  });
});

describe('driverInstallHelp', () => {
  it('gives the npx command, a client config and an npm install for jt400', () => {
    const help = driverInstallHelp('jt400');
    expect(help).toContain('npx -y -p mcp-server-db2i -p node-jt400 mcp-server-db2i');
    expect(help).toContain('"args": ["-y", "-p", "mcp-server-db2i", "-p", "node-jt400", "mcp-server-db2i"]');
    expect(help).toContain('npm install -g mcp-server-db2i node-jt400');
    expect(help).toContain('JDK');
  });

  it('lists both mapepire packages', () => {
    const help = driverInstallHelp('mapepire');
    expect(help).toContain('needs @ibm/mapepire-js and ssh2, which are not installed');
    expect(help).toContain('npx -y -p mcp-server-db2i -p @ibm/mapepire-js -p ssh2 mcp-server-db2i');
    expect(help).toContain('npm install -g mcp-server-db2i @ibm/mapepire-js ssh2');
  });
});

describe('missingDriverPackagesMessage', () => {
  it('names DB2I_DRIVER without profiles', () => {
    const message = missingDriverPackagesMessage([{ driver: 'jt400', packages: ['node-jt400'], systems: [] }]);
    expect(message.startsWith('DB2I_DRIVER=jt400.\n')).toBe(true);
  });

  it('names the profiles that use the driver', () => {
    const message = missingDriverPackagesMessage([
      { driver: 'jt400', packages: ['node-jt400'], systems: ['prod', 'test'] },
      { driver: 'mapepire', packages: ['ssh2'], systems: ['dev'] },
    ]);
    expect(message).toContain('DB2I_PROFILES: "prod", "test" use driver jt400.');
    expect(message).toContain('DB2I_PROFILES: "dev" uses driver mapepire.');
    expect(message).toContain('-p ssh2 mcp-server-db2i');
  });
});
