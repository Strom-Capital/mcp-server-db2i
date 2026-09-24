import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  defaultSystem,
  getSystems,
  resetSystems,
  resolveTarget,
  SystemsError,
  TargetError,
} from '../src/systems.js';

const originalEnv = process.env;
const dirs: string[] = [];

function tempFile(name: string, contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'db2i-systems-'));
  dirs.push(dir);
  const file = path.join(dir, name);
  writeFileSync(file, contents);
  return file;
}

function useProfiles(yaml: string): void {
  process.env.DB2I_PROFILES = tempFile('profiles.yaml', yaml);
}

const TWO_SYSTEMS = `
profiles:
  - name: prod
    host: prod.example.com
    username: \${PROD_USER}
    password: \${PROD_PASSWORD}
    schema: SALES
    allowedSchemas: [sales, qsys2]
    jdbcOptions: "secure=true;naming=sql"
  - name: test
    host: test.example.com
    driver: odbc
    username: TESTUSER
    password: \${TEST_PASSWORD}
    odbcOptions: "SSL=1"
`;

beforeEach(() => {
  process.env = { ...originalEnv };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('DB2I_') || key === 'QUERY_ALLOWED_SCHEMAS') {
      delete process.env[key];
    }
  }
  resetSystems();
});

afterEach(() => {
  process.env = originalEnv;
  resetSystems();
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe('implicit default system', () => {
  it('builds one system from DB2I_* when DB2I_PROFILES is unset', () => {
    process.env.DB2I_HOSTNAME = 'ibmi.example.com';
    process.env.DB2I_USERNAME = 'user';
    process.env.DB2I_PASSWORD = 'secret';
    process.env.DB2I_SCHEMA = 'MYLIB';
    process.env.QUERY_ALLOWED_SCHEMAS = 'mylib,qsys2';

    const systems = getSystems();
    expect(systems).toHaveLength(1);
    expect(systems[0].name).toBe('default');
    expect(systems[0].config.hostname).toBe('ibmi.example.com');
    expect(systems[0].allowedSchemas).toEqual(['MYLIB', 'QSYS2']);
    expect(systems[0].defaultSchema).toBe('MYLIB');
  });

  it('reads DB2I_* only when the connection settings are used', () => {
    const system = defaultSystem();
    expect(system.name).toBe('default');
    expect(() => system.config).toThrow(/DB2I_HOSTNAME environment variable is required/);
  });

  it('resolves a stdio call without reading credentials', () => {
    const target = resolveTarget('stdio');
    expect(target.system).toBe('default');
    expect(() => target.config).toThrow(/DB2I_HOSTNAME/);
  });
});

describe('DB2I_PROFILES', () => {
  beforeEach(() => {
    process.env.PROD_USER = 'produser';
    process.env.PROD_PASSWORD = 'prodpass';
    process.env.TEST_PASSWORD = 'testpass';
  });

  it('loads each profile with its driver, options, and allowlist', () => {
    useProfiles(TWO_SYSTEMS);
    const [prod, test] = getSystems();

    expect(prod.name).toBe('prod');
    expect(prod.config).toEqual({
      hostname: 'prod.example.com',
      port: 446,
      username: 'produser',
      password: 'prodpass',
      database: '*LOCAL',
      schema: 'SALES',
      driver: 'odbc',
      jdbcOptions: { secure: 'true', naming: 'sql' },
      odbcOptions: {},
    });
    expect(prod.allowedSchemas).toEqual(['SALES', 'QSYS2']);
    expect(prod.defaultSchema).toBe('SALES');

    expect(test.config.driver).toBe('odbc');
    expect(test.config.username).toBe('TESTUSER');
    expect(test.config.odbcOptions).toEqual({ SSL: '1' });
    expect(test.allowedSchemas).toBeUndefined();
  });

  it('gives a profile without a driver DB2I_DRIVER, and lets its own driver win', () => {
    process.env.DB2I_DRIVER = 'jt400';
    useProfiles(TWO_SYSTEMS);
    const [prod, test] = getSystems();
    expect(prod.config.driver).toBe('jt400');
    expect(test.config.driver).toBe('odbc');
  });

  it('falls back to QUERY_ALLOWED_SCHEMAS for a profile without its own list', () => {
    process.env.QUERY_ALLOWED_SCHEMAS = 'OTHERLIB';
    useProfiles(TWO_SYSTEMS);
    expect(getSystems()[1].allowedSchemas).toEqual(['OTHERLIB']);
  });

  it('reads credentials from files', () => {
    const passwordFile = tempFile('password', 'filepass\n');
    process.env.PASSWORD_PATH = tempFile('password2', 'refpass\n');
    useProfiles(`
profiles:
  - name: a
    host: a.example.com
    username: A
    passwordFile: ${passwordFile}
  - name: b
    host: b.example.com
    username: B
    passwordFile: \${PASSWORD_PATH}
`);
    const [a, b] = getSystems();
    expect(a.config.password).toBe('filepass');
    expect(b.config.password).toBe('refpass');
  });

  it('refuses a literal password', () => {
    useProfiles(`
profiles:
  - name: prod
    host: prod.example.com
    username: USER
    password: hunter2
`);
    expect(() => getSystems()).toThrow(SystemsError);
    expect(() => getSystems()).toThrow(/profile prod: password must be a \$\{ENV_VAR\} reference/);
  });

  it('refuses a reference to an unset variable', () => {
    useProfiles(`
profiles:
  - name: prod
    host: prod.example.com
    username: USER
    password: \${NOT_SET_ANYWHERE}
`);
    expect(() => getSystems()).toThrow(/\$\{NOT_SET_ANYWHERE\} is not set/);
  });

  it('refuses both password and passwordFile', () => {
    useProfiles(`
profiles:
  - name: prod
    host: prod.example.com
    username: USER
    password: \${PROD_PASSWORD}
    passwordFile: /run/secrets/pw
`);
    expect(() => getSystems()).toThrow(/set password or passwordFile, not both/);
  });

  it('refuses duplicate names', () => {
    useProfiles(`
profiles:
  - { name: prod, host: a.example.com, username: A, password: "\${PROD_PASSWORD}" }
  - { name: prod, host: b.example.com, username: B, password: "\${PROD_PASSWORD}" }
`);
    expect(() => getSystems()).toThrow(/profile prod: the name is used more than once/);
  });

  it('refuses an invalid host, driver, or unknown field', () => {
    useProfiles(`
profiles:
  - { name: prod, host: "bad host!", username: A, password: "\${PROD_PASSWORD}" }
`);
    expect(() => getSystems()).toThrow(/not a valid hostname/);

    resetSystems();
    useProfiles(`
profiles:
  - { name: prod, host: a.example.com, driver: db2cli, username: A, password: "\${PROD_PASSWORD}" }
`);
    expect(() => getSystems()).toThrow(SystemsError);

    resetSystems();
    useProfiles(`
profiles:
  - { name: prod, host: a.example.com, hostname: x, username: A, password: "\${PROD_PASSWORD}" }
`);
    expect(() => getSystems()).toThrow(SystemsError);
  });

  it('refuses an empty list and a missing file', () => {
    useProfiles('profiles: []\n');
    expect(() => getSystems()).toThrow(SystemsError);

    resetSystems();
    process.env.DB2I_PROFILES = path.join(tmpdir(), 'no-such-profiles.yaml');
    expect(() => getSystems()).toThrow(/DB2I_PROFILES/);
  });

  it('ignores DB2I_HOSTNAME once a profiles file is set', () => {
    process.env.DB2I_HOSTNAME = 'env.example.com';
    useProfiles(TWO_SYSTEMS);
    expect(defaultSystem().config.hostname).toBe('prod.example.com');
  });
});

describe('resolveTarget', () => {
  beforeEach(() => {
    process.env.PROD_USER = 'produser';
    process.env.PROD_PASSWORD = 'prodpass';
    process.env.TEST_PASSWORD = 'testpass';
    useProfiles(TWO_SYSTEMS);
  });

  it('uses the first profile when no system is named', () => {
    const target = resolveTarget('stdio');
    expect(target.system).toBe('prod');
    expect(target.poolKey).toBe('stdio');
    expect(target.allowedSchemas).toEqual(['SALES', 'QSYS2']);
    expect(target.defaultSchema).toBe('SALES');
  });

  it('uses the named profile', () => {
    const target = resolveTarget('token-1', 'test');
    expect(target.system).toBe('test');
    expect(target.config.hostname).toBe('test.example.com');
    expect(target.allowedSchemas).toBeUndefined();
  });

  it('names the configured systems for an unknown one', () => {
    expect(() => resolveTarget('stdio', 'dev')).toThrow(TargetError);
    expect(() => resolveTarget('stdio', 'dev')).toThrow('Unknown system "dev". Available: prod, test');
  });

  it('keeps a bound session on its system with its own credentials', () => {
    const config = { ...getSystems()[1].config, username: 'CALLER', password: 'callerpass', schema: 'MINE' };
    const binding = { system: 'test', config };

    const target = resolveTarget('token-1', undefined, binding);
    expect(target.system).toBe('test');
    expect(target.config.username).toBe('CALLER');
    expect(target.defaultSchema).toBe('MINE');
    expect(resolveTarget('token-1', 'test', binding).system).toBe('test');

    expect(() => resolveTarget('token-1', 'prod', binding)).toThrow(
      /This session is bound to system "test"/
    );
  });
});
