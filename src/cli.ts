/**
 * Command-line entry points that do not start a transport.
 *
 * `validate-tools` checks YAML tool files and exits. `--help` and `--version` print and exit.
 */

import { parseArgs } from 'node:util';

import { classifyParsedStatement } from './customTools/execute.js';
import {
  systemLoadOptions,
  validateCustomToolFiles,
  type FileValidationResult,
  type LoadCustomToolsOptions,
  type StoredTool,
} from './customTools/loader.js';
import { closeGlobalPool, initializePool } from './db/connection.js';
import { defaultSystem, resolveTarget, STDIO_POOL_KEY, type DbTarget } from './systems.js';
import {
  isParseStatementMissing,
  parseStatement,
  PARSE_STATEMENT_REQUIREMENT,
} from './db/sqlServices.js';

const USAGE = `Usage: mcp-server-db2i [validate-tools [--connect] <path...>]

  (no arguments)             Start the MCP server (stdio unless MCP_TRANSPORT is set)
  validate-tools <path...>   Check YAML tool files and exit
  --connect                   Also parse each statement with QSYS2.PARSE_STATEMENT
  -h, --help                 Show this help
  -v, --version              Show the version

Docs: https://docs.db2i-mcp.com
`;

const SETUP = `mcp-server-db2i is an MCP server. An MCP client such as Claude, Cursor or VS Code
starts it and talks to it over stdin/stdout, so running it by hand only checks the setup.

No IBM i connection is configured. Set these environment variables:

  DB2I_HOSTNAME   IBM i host name or IP address
  DB2I_USERNAME   IBM i user profile
  DB2I_PASSWORD   Password (or DB2I_PASSWORD_FILE)
  DB2I_SCHEMA     Default library (optional)

Or point DB2I_PROFILES at a YAML file that lists several systems.

Example client config (Claude Desktop, Cursor):

  {
    "mcpServers": {
      "db2i": {
        "command": "npx",
        "args": ["-y", "mcp-server-db2i@latest"],
        "env": {
          "DB2I_HOSTNAME": "ibmi.example.com",
          "DB2I_USERNAME": "MYUSER",
          "DB2I_PASSWORD": "..."
        }
      }
    }
  }

The default driver needs the IBM i Access ODBC Driver. Quickstart and other drivers:
https://docs.db2i-mcp.com/quickstart
`;

export type CliCommand =
  | { kind: 'serve' }
  | { kind: 'help'; message: string }
  | { kind: 'version' }
  | { kind: 'validate-tools'; paths: string[]; connect: boolean }
  | { kind: 'usage'; message: string };

/**
 * No arguments starts the server. Anything else is validate-tools or a usage error.
 */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  if (argv.length === 0) {
    return { kind: 'serve' };
  }

  const [command, ...rest] = argv;
  if (command === '-h' || command === '--help' || command === 'help') {
    return { kind: 'help', message: USAGE };
  }
  if (command === '-v' || command === '--version') {
    return { kind: 'version' };
  }
  if (command !== 'validate-tools') {
    return { kind: 'usage', message: `Unknown command: ${command}\n\n${USAGE}` };
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...rest],
      options: {
        connect: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid arguments';
    return { kind: 'usage', message: `${message}\n\n${USAGE}` };
  }

  if (parsed.positionals.length === 0) {
    return { kind: 'usage', message: `validate-tools requires at least one path.\n\n${USAGE}` };
  }

  return {
    kind: 'validate-tools',
    paths: parsed.positionals,
    connect: parsed.values.connect === true,
  };
}

/**
 * A setup guide when stdio would start with no connection settings at all, else null.
 * A first `npx mcp-server-db2i` lands here, so it gets instructions instead of a stack trace.
 * Partial settings still get the specific error from config loading.
 */
export function missingConnectionHelp(env: NodeJS.ProcessEnv = process.env): string | null {
  const transport = env.MCP_TRANSPORT?.toLowerCase();
  if (transport === 'http') {
    return null;
  }
  if (env.DB2I_PROFILES?.trim() || env.DB2I_HOSTNAME?.trim()) {
    return null;
  }
  return SETUP;
}

export async function runValidateTools(options: {
  paths: string[];
  connect: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  let loadOptions: LoadCustomToolsOptions;
  try {
    loadOptions = systemLoadOptions();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load DB2I_PROFILES';
    stderr.write(`FAIL ${message}\n`);
    return 1;
  }
  const { results, loaded } = validateCustomToolFiles(options.paths, loadOptions);

  let failed = reportFiles(results, stdout, stderr);

  if (options.connect && !failed) {
    const connectFailed = await checkOnServer(loaded.tools, stderr);
    failed = failed || connectFailed;
  }

  const fileCount = results.filter((result) => result.path !== '').length;
  const staticFailures = results.filter((result) => result.error).length;
  const summary = !failed
    ? `${fileCount} files checked, all passed.`
    : staticFailures > 0
      ? `${fileCount} files checked, ${staticFailures} failed.`
      : `${fileCount} files checked, PARSE_STATEMENT check failed.`;
  stdout.write(`${summary}\n`);
  return failed ? 1 : 0;
}

function reportFiles(
  results: FileValidationResult[],
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): boolean {
  let failed = false;
  for (const result of results) {
    if (result.error) {
      failed = true;
      const where = result.path ? `${result.path}: ` : '';
      stderr.write(`FAIL ${where}${result.error}\n`);
    } else {
      stdout.write(`ok  ${result.path} (${result.tools} tools, ${result.annotations} annotations)\n`);
    }
  }
  return failed;
}

/**
 * Run each statement through QSYS2.PARSE_STATEMENT on the tool's system.
 * A missing function stops the command and names the host.
 */
async function checkOnServer(tools: StoredTool[], stderr: NodeJS.WritableStream): Promise<boolean> {
  const targets: DbTarget[] = [];
  try {
    const fallback = defaultSystem();
    initializePool(fallback.config, fallback.name);
    for (const tool of tools) {
      targets.push(resolveTarget(STDIO_POOL_KEY, tool.system));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not load database configuration';
    stderr.write(`FAIL ${message}\n`);
    await closeGlobalPool();
    return true;
  }

  try {
    let failed = false;
    for (const [index, tool] of tools.entries()) {
      const target = targets[index];
      try {
        const parsed = await parseStatement(tool.sql, target);
        const outcome = classifyParsedStatement(parsed);
        if (!outcome.ok) {
          failed = true;
          stderr.write(`FAIL ${tool.source}: tool ${tool.name}: ${outcome.error}\n`);
        }
      } catch (error) {
        if (isParseStatementMissing(error)) {
          stderr.write(
            `FAIL QSYS2.PARSE_STATEMENT is not available on ${target.config.hostname}. ${PARSE_STATEMENT_REQUIREMENT}\n`,
          );
          return true;
        }
        failed = true;
        const message = error instanceof Error ? error.message : 'Unknown error occurred';
        stderr.write(`FAIL ${tool.source}: tool ${tool.name}: ${message}\n`);
      }
    }
    return failed;
  } finally {
    await closeGlobalPool();
  }
}
