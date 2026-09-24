/**
 * Command-line entry points that do not start a transport.
 *
 * `validate-tools` checks YAML tool files and exits.
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

  validate-tools <path...>   Check YAML tool files and exit
  --connect                   Also parse each statement with QSYS2.PARSE_STATEMENT
`;

export type CliCommand =
  | { kind: 'serve' }
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
