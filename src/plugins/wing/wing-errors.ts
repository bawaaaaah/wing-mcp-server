/**
 * Error hierarchy for the WING plugin. Every error thrown from the OSC/meter
 * control-plane code should be (or wrap into) one of these so the MCP tools
 * layer can catch a single base class and turn it into a tool-visible
 * `{isError: true, content: [...]}` result instead of a JSON-RPC error.
 */

export class WingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The console is unreachable (connect failed, socket closed, no network path). */
export class WingUnavailableError extends WingError {}

/** A request to the console did not receive a matching reply in time. */
export class WingTimeoutError extends WingError {}

/** A value failed local validation (range, enum membership, type) before send. */
export class WingValueError extends WingError {}

/**
 * The console replied to a bulk-set with a non-OK ack status. Carries the
 * raw ack string (e.g. "NODE NOT FOUND", "VALUE ERROR") for diagnostics.
 */
export class WingProtocolError extends WingError {
  readonly ackStatus: string;

  constructor(ackStatus: string, message?: string) {
    super(message ?? `WING console returned ack status: ${ackStatus}`);
    this.ackStatus = ackStatus;
  }
}

/** The client's outbound request queue is full; the request was rejected without being sent. */
export class WingQueueOverflowError extends WingError {}

/**
 * The caller cancelled a long-running operation. Raised at the loop boundaries of the automation
 * tools (see long-running.ts) so a cancelled request actually stops driving the console, instead of
 * running to completion with nobody listening.
 */
export class WingCancelledError extends WingError {
  constructor(what: string) {
    super(`${what} was cancelled by the caller`);
  }
}
