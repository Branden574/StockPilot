import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAIAbortError, GoogleGenerativeAIFetchError } from '@google/generative-ai';

import { classifyAiError, geminiRefusedKey } from './errors';

/**
 * How an AI chat tool says it failed (docket S30).
 *
 * A tool reports a failure by THROWING one of the two errors below, never by
 * returning an `{ error }` object. Both chat loops turn a throw into one
 * report (toolFailureForModel, chat.ts), a failed tool badge, a failed audit
 * row for a write tool, and one sentence for the model. A returned object
 * would be counted, badged and audited as a success.
 *
 *   ToolUnavailableError  the feature behind the tool is not set up, is not
 *                         available right now, or could not finish. Its
 *                         message is one of the fixed sentences below, chosen
 *                         by tool and kind. The cause (a database error, the
 *                         AI service's error) is kept for the report and is
 *                         never part of the message.
 *   ToolRefusal           the tool explains, in its own words, why it will not
 *                         run: an argument it cannot use, a change the app
 *                         does not allow, a write that did not land. Built
 *                         only under lib/ai, from fixed words (the raw error
 *                         text guard reads every construction).
 */

export type ToolFailureKind = 'not_set_up' | 'unavailable' | 'failed';

export type ToolWithFailureSentences =
  'searchInventorySemantic' | 'backfillEmbeddings' | 'identifyFromPhoto';

/** What the model reads for each failure kind. String literals only. */
export const TOOL_FAILURE_SENTENCES: Record<
  ToolWithFailureSentences,
  Record<ToolFailureKind, string>
> = {
  searchInventorySemantic: {
    not_set_up: 'Search by meaning is not set up. Search by name, SKU or barcode instead.',
    unavailable:
      'Search by meaning is not available right now. Search by name, SKU or barcode instead, or try again in a few minutes.',
    failed: 'Search by meaning could not finish. Search by name, SKU or barcode instead.',
  },
  backfillEmbeddings: {
    not_set_up: 'Search by meaning is not set up, so its search data cannot be filled in.',
    unavailable:
      'The service that builds the search data is not available right now. Try again in a few minutes.',
    failed: 'The search data could not be filled in just now. Try again in a few minutes.',
  },
  identifyFromPhoto: {
    not_set_up: 'Photo identification is not set up.',
    unavailable: 'Photo identification is not available right now. Try again in a few minutes.',
    // The same words as VISION_FAILED_MESSAGE (server/lib/api-error-response.ts),
    // which the phone's photo route answers; a test keeps the two equal.
    failed: 'The photo could not be read. Try again.',
  },
};

export function toolFailureSentence(tool: ToolWithFailureSentences, kind: ToolFailureKind): string {
  return TOOL_FAILURE_SENTENCES[tool][kind];
}

export class ToolUnavailableError extends Error {
  /**
   * `opts.cause` is what failed underneath (Error's own `cause`): for the
   * report only, never part of the message.
   */
  constructor(
    public readonly tool: ToolWithFailureSentences,
    public readonly kind: ToolFailureKind,
    opts: { cause?: unknown } = {},
  ) {
    super(
      toolFailureSentence(tool, kind),
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.name = 'ToolUnavailableError';
  }
}

export class ToolRefusal extends Error {
  /**
   * `opts.cause` is what was refused underneath (the address guard's error, an
   * image host's status): for the report only, never part of the message.
   */
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ToolRefusal';
  }
}

/** A 429 or any 5xx: the service answered that it cannot serve this now. */
function busyOrDown(status: number | undefined): boolean {
  return status === 429 || (typeof status === 'number' && status >= 500);
}

/**
 * Which failure kind an AI service's error is. Read from the SDKs' error
 * classes and HTTP status first. What is left goes through classifyAiError,
 * whose code only chooses between the fixed sentences above; the error's own
 * words are never passed on.
 */
export function aiProviderFailureKind(e: unknown): ToolFailureKind {
  if (e instanceof GoogleGenerativeAIAbortError) return 'unavailable';
  if (e instanceof GoogleGenerativeAIFetchError) {
    if (e.status === 401 || e.status === 403 || geminiRefusedKey(e)) return 'not_set_up';
    if (busyOrDown(e.status)) return 'unavailable';
  } else if (e instanceof Anthropic.APIConnectionError) {
    // Its timeout class extends it.
    return 'unavailable';
  } else if (e instanceof Anthropic.APIError) {
    if (e.status === 401 || e.status === 403) return 'not_set_up';
    if (busyOrDown(e.status)) return 'unavailable';
  }
  switch (classifyAiError(e).code) {
    case 'auth':
      return 'not_set_up';
    case 'billing':
    case 'rate_limit':
    case 'transient':
      return 'unavailable';
    default:
      return 'failed';
  }
}
