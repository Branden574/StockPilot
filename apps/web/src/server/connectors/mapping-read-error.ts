import 'server-only';

/**
 * The connection_mappings read behind `deps.getMapping` failed: an error
 * answer, an answer that is not a list (docket S27), or two mappings for one
 * local id. Its message is the failure's own (`cause`), which the drainer
 * stores as the attempt's last_error.
 *
 * It is StockPilot's own read, not a provider's answer, so a connector that
 * catches it reports it retryable: the drainer puts the attempt into 'error'
 * with backoff, as it does for any error thrown out of a connector, and
 * dead-letters it only at MAX_ATTEMPTS. Each connector reads its mappings
 * before it posts anything, so a retry posts nothing twice.
 *
 * Without it, QuickBooks and Sage Intacct read the supplier's mapping inside
 * the try whose catch decides `retryable` from the thrown error's `status`,
 * meant for the provider's HTTP status: a ListReadError carries PostgREST's
 * status (200 or 204) and an error answer carries none, and both read as a
 * caller error, so the export went to 'dead' at once.
 */
export class MappingReadError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = 'MappingReadError';
  }
}
