/**
 * Errors whose text is safe to hand back to an agent.
 *
 * `worker.ts` passes the message of an `OperatorFacingError` straight through
 * and replaces anything else with "The inventory request failed." That policy
 * only works if there is one obvious way to opt in, so every error this plugin
 * raises on purpose extends this class, and everything else — a `pg` error
 * carrying a hostname, a `TypeError` carrying row data — is caught by the
 * default.
 */
export class OperatorFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The caller passed something this tool cannot work with. */
export class InputError extends OperatorFacingError {}

/** The database could not be reached, migrated, or read. */
export class StorageError extends OperatorFacingError {}

/** The write was well-formed but would have broken a ledger invariant. */
export class LedgerError extends OperatorFacingError {}
