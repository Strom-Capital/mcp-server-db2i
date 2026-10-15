/**
 * Signed `requestState` for elicitation (MCP multi round-trip, 2026-07-28).
 *
 * The state comes back from the client, so it is untrusted. It is signed with
 * HMAC and expires, and it names the caller, the tool and a hash of the
 * arguments. Each state can answer one call: its nonce is used up on the retry.
 */

import crypto from 'node:crypto';
import { createRequestStateCodec, type RequestStateCodec } from '@modelcontextprotocol/server';

import { getElicitationSecret } from '../config.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger({ component: 'elicitation' });

/** Seconds a question stays answerable. */
export const STATE_TTL_SECONDS = 300;

/** Kept apart from the OAuth signing and grant store keys derived from the same secret. */
const KEY_INFO = 'mcp-server-db2i elicitation state v1';

/** What a question is about. */
export type ElicitationKind = 'export_rows' | 'tool_params';

/** Who asked, in which tool, with which arguments. */
export interface ElicitationBinding {
  identity: string;
  tool: string;
  /** argsHash of the tool arguments. */
  args: string;
}

/** The payload inside a signed state. */
export interface ElicitationState extends ElicitationBinding {
  kind: ElicitationKind;
  nonce: string;
}

let codec: RequestStateCodec<ElicitationState> | undefined;

function signingKey(): Buffer {
  const configured = getElicitationSecret();
  if (configured?.source === 'elicitation') {
    return Buffer.from(configured.secret, 'utf8');
  }
  if (configured?.source === 'oauth') {
    return Buffer.from(crypto.hkdfSync('sha256', configured.secret, Buffer.alloc(0), KEY_INFO, 32));
  }
  const transport = process.env.MCP_TRANSPORT?.trim().toLowerCase();
  if (transport === 'http' || transport === 'both') {
    log.warn(
      'Neither MCP_ELICITATION_SECRET nor MCP_OAUTH_SECRET is set, so elicitation state is signed with a key for this process only. ' +
        'Set one when several instances serve the same clients.'
    );
  }
  return crypto.randomBytes(32);
}

/**
 * The codec that mints and verifies states. Created on first use, with the
 * key from MCP_ELICITATION_SECRET, MCP_OAUTH_SECRET or a random one.
 */
export function stateCodec(): RequestStateCodec<ElicitationState> {
  codec ??= createRequestStateCodec<ElicitationState>({ key: signingKey(), ttlSeconds: STATE_TTL_SECONDS });
  return codec;
}

/** Forget the codec and used nonces. For tests that change the secret. */
export function resetElicitationState(): void {
  codec = undefined;
  used.clear();
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)])
    );
  }
  return value;
}

/**
 * SHA-256 of the arguments as JSON with sorted keys, so the same call hashes the
 * same whatever order the client sends the keys in.
 */
export function argsHash(args: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(args ?? {}))).digest('base64url');
}

/** A fresh nonce for a new question. */
export function newNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** Nonces already answered, with the time they can be forgotten. */
const used = new Map<string, number>();

function forgetExpired(now: number): void {
  for (const [nonce, until] of used) {
    if (until <= now) {
      used.delete(nonce);
    }
  }
}

/** Why a signed state does not answer this call. */
export type StateCheck = 'ok' | 'mismatch' | 'replayed';

/**
 * Check a verified state against the call it came back with, and use up its
 * nonce. A state from another caller, tool or set of arguments is a mismatch;
 * one whose nonce was already used is a replay.
 */
export function checkState(state: ElicitationState, expected: ElicitationBinding, now = Date.now()): StateCheck {
  if (state.identity !== expected.identity || state.tool !== expected.tool || state.args !== expected.args) {
    return 'mismatch';
  }
  forgetExpired(now);
  if (used.has(state.nonce)) {
    return 'replayed';
  }
  // The signature expires after the TTL, so the nonce need not be kept longer
  used.set(state.nonce, now + STATE_TTL_SECONDS * 1000);
  return 'ok';
}
