/**
 * Ask the user a form question in the middle of a tool call.
 *
 * On the 2026-07-28 revision a tool returns `input_required` and the client
 * retries the call with the answer. For 2025-era clients on stdio or stateful
 * HTTP, the SDK's legacy shim sends `elicitation/create` and retries the
 * handler itself. Stateless 2025-era HTTP cannot reach the client, so no
 * question is asked there.
 *
 * Elicitation is a convenience, not a gate: the answer comes from the client.
 * Every check that runs without a question still runs after one.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  inputResponse,
  type ClientCapabilities,
  type ElicitRequestFormParams,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';

import {
  argsHash,
  checkState,
  newNonce,
  stateCodec,
  type ElicitationBinding,
  type ElicitationKind,
  type ElicitationState,
  type StateCheck,
} from './state.js';

/** Key of the one form question in `inputRequests` and `inputResponses`. */
const QUESTION_KEY = 'question';

/** What happened to a question, for the audit log. */
export interface ElicitationNote {
  kind: ElicitationKind;
  outcome: 'asked' | 'accept' | 'decline' | 'cancel';
}

/** The user's answer to a question asked on the previous round. */
export type ElicitationAnswer =
  | { action: 'accept'; content: Record<string, unknown> }
  | { action: 'decline' | 'cancel' };

/**
 * True when the client declared form-mode elicitation for this request: in the
 * request's 2026-07-28 envelope, or at `initialize` on a 2025-era connection.
 * An empty `elicitation` object means form mode.
 */
export function canElicitForm(ctx: ServerContext | undefined, initialized?: ClientCapabilities): boolean {
  const envelope = ctx?.mcpReq?.envelope as Record<string, unknown> | undefined;
  const capabilities = (envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined) ?? initialized;
  const elicitation = capabilities?.elicitation as Record<string, unknown> | undefined;
  if (!elicitation || typeof elicitation !== 'object') {
    return false;
  }
  return Object.keys(elicitation).length === 0 || elicitation.form !== undefined;
}

function isElicitationState(value: unknown): value is ElicitationState {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const state = value as Record<string, unknown>;
  return ['kind', 'nonce', 'identity', 'tool', 'args'].every((key) => typeof state[key] === 'string');
}

/**
 * One tool call's view of elicitation. withToolHandler creates it before the
 * handler runs and checks any state the call carries.
 */
export class Elicitor {
  /** What the audit log records about the question, if one was asked or answered. */
  note?: ElicitationNote;

  /** How the state this call carried failed, when it did. */
  readonly rejected?: Exclude<StateCheck, 'ok'> | 'malformed';

  private readonly state?: ElicitationState;
  private readonly binding: ElicitationBinding;

  /**
   * @param ctx - The request context; undefined in unit tests that call handlers directly
   * @param caller - Identity and tool name of the call
   * @param args - Tool arguments, as the handler gets them
   * @param available - The client can answer a form question on this request
   */
  constructor(
    private readonly ctx: ServerContext | undefined,
    caller: { identity: string; tool: string },
    args: unknown,
    readonly available: boolean,
  ) {
    this.binding = { ...caller, args: argsHash(args) };
    const raw = ctx?.mcpReq?.requestState?.<unknown>();
    if (raw === undefined) {
      return;
    }
    if (!isElicitationState(raw)) {
      this.rejected = 'malformed';
      return;
    }
    const check = checkState(raw, this.binding);
    if (check !== 'ok') {
      this.rejected = check;
      return;
    }
    this.state = raw;
  }

  /** The call carries a verified answer to an earlier question, so it is the same call retried. */
  get isRetry(): boolean {
    return this.state !== undefined;
  }

  /**
   * The answer to a question of this kind asked on the previous round, or
   * undefined when there was none. The content is untrusted: validate it.
   */
  answer(kind: ElicitationKind): ElicitationAnswer | undefined {
    if (this.state?.kind !== kind) {
      return undefined;
    }
    const view = inputResponse(this.ctx?.mcpReq?.inputResponses, QUESTION_KEY);
    if (view.kind !== 'elicit') {
      // A retry without a usable answer counts as cancelled
      this.note = { kind, outcome: 'cancel' };
      return { action: 'cancel' };
    }
    this.note = { kind, outcome: view.action };
    if (view.action === 'accept') {
      return { action: 'accept', content: view.content ?? {} };
    }
    return { action: view.action };
  }

  /**
   * The `input_required` result that asks the question. The client shows the
   * form and calls the tool again with the same arguments and the answer.
   */
  async ask(
    kind: ElicitationKind,
    message: string,
    requestedSchema: ElicitRequestFormParams['requestedSchema'],
  ): Promise<InputRequiredResult> {
    const requestState = await stateCodec().mint({ ...this.binding, kind, nonce: newNonce() });
    this.note = { kind, outcome: 'asked' };
    return inputRequired({
      inputRequests: { [QUESTION_KEY]: inputRequired.elicit({ message, requestedSchema }) },
      requestState,
    });
  }
}
