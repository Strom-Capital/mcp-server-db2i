import type { ServerContext } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Elicitor, canElicitForm } from '../../src/elicitation/elicitor.js';
import {
  STATE_TTL_SECONDS,
  argsHash,
  checkState,
  newNonce,
  resetElicitationState,
  stateCodec,
  type ElicitationState,
} from '../../src/elicitation/state.js';

const SECRET = 'x'.repeat(40);

/** A request context whose requestState is a verified payload, as the SDK hands it to handlers. */
function ctxWith(state: unknown, inputResponses?: Record<string, unknown>, envelope?: Record<string, unknown>): ServerContext {
  return {
    mcpReq: {
      requestState: () => state,
      inputResponses,
      envelope,
    },
  } as unknown as ServerContext;
}

function stateFor(overrides: Partial<ElicitationState> = {}): ElicitationState {
  return {
    kind: 'export_rows',
    nonce: newNonce(),
    identity: 'alice',
    tool: 'export_query',
    args: argsHash({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' }),
    ...overrides,
  };
}

const previousEnv = process.env;

beforeEach(() => {
  process.env = { ...previousEnv, MCP_ELICITATION_SECRET: SECRET };
  delete process.env.MCP_OAUTH_SECRET;
  resetElicitationState();
});

afterEach(() => {
  vi.useRealTimers();
  process.env = previousEnv;
  resetElicitationState();
});

describe('argsHash', () => {
  it('ignores key order and undefined values', () => {
    expect(argsHash({ a: 1, b: { c: 2, d: 3 } })).toBe(argsHash({ b: { d: 3, c: 2 }, a: 1, e: undefined }));
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }));
  });
});

describe('state codec', () => {
  it('verifies what it minted', async () => {
    const state = stateFor();
    const wire = await stateCodec().mint(state);
    await expect(stateCodec().verify(wire, ctxWith(undefined))).resolves.toEqual(state);
  });

  it('rejects a tampered state', async () => {
    const wire = await stateCodec().mint(stateFor());
    const [version, body, mac] = wire.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    payload.p.identity = 'mallory';
    const forged = [version, Buffer.from(JSON.stringify(payload)).toString('base64url'), mac].join('.');
    await expect(stateCodec().verify(forged, ctxWith(undefined))).rejects.toThrow();
    await expect(stateCodec().verify(`${wire}x`, ctxWith(undefined))).rejects.toThrow();
  });

  it('rejects an expired state', async () => {
    vi.useFakeTimers();
    const wire = await stateCodec().mint(stateFor());
    vi.advanceTimersByTime((STATE_TTL_SECONDS + 1) * 1000);
    await expect(stateCodec().verify(wire, ctxWith(undefined))).rejects.toThrow();
  });

  it('rejects a state signed with another key', async () => {
    const wire = await stateCodec().mint(stateFor());
    process.env.MCP_ELICITATION_SECRET = 'y'.repeat(40);
    resetElicitationState();
    await expect(stateCodec().verify(wire, ctxWith(undefined))).rejects.toThrow();
  });

  it('derives a key from MCP_OAUTH_SECRET that instances share', async () => {
    delete process.env.MCP_ELICITATION_SECRET;
    process.env.MCP_OAUTH_SECRET = SECRET;
    resetElicitationState();
    const wire = await stateCodec().mint(stateFor());
    resetElicitationState();
    await expect(stateCodec().verify(wire, ctxWith(undefined))).resolves.toMatchObject({ kind: 'export_rows' });
  });

  it('refuses a short MCP_ELICITATION_SECRET', () => {
    process.env.MCP_ELICITATION_SECRET = 'short';
    expect(() => stateCodec()).toThrow(/at least 32 characters/);
  });
});

describe('checkState', () => {
  const binding = { identity: 'alice', tool: 'export_query', args: argsHash({ sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' }) };

  it('accepts a state once and rejects a replay', () => {
    const state = stateFor();
    expect(checkState(state, binding)).toBe('ok');
    expect(checkState(state, binding)).toBe('replayed');
  });

  it('rejects a state from another user, tool or set of arguments', () => {
    expect(checkState(stateFor({ identity: 'bob' }), binding)).toBe('mismatch');
    expect(checkState(stateFor({ tool: 'execute_query' }), binding)).toBe('mismatch');
    expect(checkState(stateFor({ args: argsHash({ sql: 'SELECT * FROM MYLIB.CUSTOMERS' }) }), binding)).toBe('mismatch');
  });

  it('forgets a nonce after the state could no longer verify', () => {
    const state = stateFor();
    const now = Date.now();
    expect(checkState(state, binding, now)).toBe('ok');
    expect(checkState(state, binding, now + (STATE_TTL_SECONDS + 1) * 1000)).toBe('ok');
  });
});

describe('canElicitForm', () => {
  it('reads the 2026-07-28 envelope first, then the initialize capabilities', () => {
    const key = 'io.modelcontextprotocol/clientCapabilities';
    expect(canElicitForm(ctxWith(undefined, undefined, { [key]: { elicitation: {} } }))).toBe(true);
    expect(canElicitForm(ctxWith(undefined, undefined, { [key]: { elicitation: { form: {} } } }))).toBe(true);
    expect(canElicitForm(ctxWith(undefined, undefined, { [key]: { elicitation: { url: {} } } }))).toBe(false);
    expect(canElicitForm(ctxWith(undefined, undefined, { [key]: {} }), { elicitation: {} })).toBe(false);
    expect(canElicitForm(ctxWith(undefined), { elicitation: {} })).toBe(true);
    expect(canElicitForm(ctxWith(undefined), {})).toBe(false);
    expect(canElicitForm(undefined, undefined)).toBe(false);
  });
});

describe('Elicitor', () => {
  const args = { sql: 'SELECT ORDERNO FROM MYLIB.ORDERS' };
  const caller = { identity: 'alice', tool: 'export_query' };

  it('asks with a state that answers the same call', async () => {
    const first = new Elicitor(ctxWith(undefined), caller, args, true);
    expect(first.isRetry).toBe(false);
    expect(first.answer('export_rows')).toBeUndefined();
    const result = await first.ask('export_rows', 'Export?', { type: 'object', properties: {} });
    expect(result.resultType).toBe('input_required');
    expect(first.note).toEqual({ kind: 'export_rows', outcome: 'asked' });

    const verified = await stateCodec().verify(result.requestState as string, ctxWith(undefined));
    const retry = new Elicitor(
      ctxWith(verified, { question: { action: 'accept', content: { max_rows: 10 } } }),
      caller,
      args,
      true,
    );
    expect(retry.rejected).toBeUndefined();
    expect(retry.isRetry).toBe(true);
    expect(retry.answer('export_rows')).toEqual({ action: 'accept', content: { max_rows: 10 } });
    expect(retry.note).toEqual({ kind: 'export_rows', outcome: 'accept' });

    const replay = new Elicitor(ctxWith(verified, { question: { action: 'accept', content: {} } }), caller, args, true);
    expect(replay.rejected).toBe('replayed');
    expect(replay.isRetry).toBe(false);
  });

  it('reports a declined, cancelled or missing answer', () => {
    for (const action of ['decline', 'cancel'] as const) {
      const elicit = new Elicitor(ctxWith(stateFor({ args: argsHash(args) }), { question: { action } }), caller, args, true);
      expect(elicit.answer('export_rows')).toEqual({ action });
      expect(elicit.note?.outcome).toBe(action);
    }
    const empty = new Elicitor(ctxWith(stateFor({ args: argsHash(args) }), {}), caller, args, true);
    expect(empty.answer('export_rows')).toEqual({ action: 'cancel' });
  });

  it('rejects a state for other arguments and a malformed state', () => {
    expect(new Elicitor(ctxWith(stateFor()), caller, { sql: 'SELECT 1 FROM SYSIBM.SYSDUMMY1' }, true).rejected).toBe('mismatch');
    expect(new Elicitor(ctxWith({ kind: 'export_rows' }), caller, args, true).rejected).toBe('malformed');
  });

  it('gives no answer for a question of another kind', () => {
    const elicit = new Elicitor(ctxWith(stateFor({ args: argsHash(args) }), { question: { action: 'accept', content: {} } }), caller, args, true);
    expect(elicit.answer('tool_params')).toBeUndefined();
  });
});
