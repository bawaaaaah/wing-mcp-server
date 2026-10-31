/**
 * Writes a control shows ahead of the console — a fader dragged, a mute pressed, a send switched —
 * and what it goes back to when one does not take. While a field's writes travel, the value the
 * console is known to hold is kept: the one the field showed before the first of them, then each
 * one the console acknowledged. When the newest write fails, the field goes back to it; an older
 * write's failure is left to the newer one on its way, whose answer is what the console ends on.
 * Plain bookkeeping with no React in it, so the rules can be tested on their own.
 */

/** The part of a write route's answer (the console's WingAck) that says whether it took. */
export interface WriteAck {
  ok: boolean;
  status: string;
}

/** Why a write did not take, from the ack it was answered with; undefined when it took. */
export function ackError(ack: WriteAck | undefined): string | undefined {
  if (!ack || ack.ok) return undefined;
  // An OK ack the server read back and found stored differently (a name the console trimmed).
  if (ack.status === "MISMATCH") return "The console stored a different value.";
  return `Not set: the console answered ${ack.status}.`;
}

/** Why a write did not take, from the error it was rejected with (a 422 names the bad value). */
export function rejectionError(err: unknown): string {
  return `Not set: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Why a write did not take, or undefined once it took: a rejected request (a 422, the console not
 * answering) and an ack that is not OK (VALUE ERROR, NODE NOT FOUND) alike. Never rejects, so a
 * caller that only reports the failure leaves no unhandled rejection behind.
 */
export function writeOutcome(write: Promise<WriteAck>): Promise<string | undefined> {
  return write.then(ackError, rejectionError);
}

/** One write on its way: the edit whose value it carries. */
export interface WriteTicket<V> {
  seq: number;
  value: V;
}

interface Field<V> {
  /** The value the console is known to hold. */
  held: V;
  /** The number of the edit that started this field's writes; older answers are not its own. */
  since: number;
  newest: WriteTicket<V>;
}

export class OptimisticWrites<V> {
  private seq = 0;
  private readonly fields = new Map<string, Field<V>>();

  /**
   * The user set a field from `shown` (what it showed until now) to `value`. The first edit while
   * nothing of the field's is on its way keeps `shown` as the console's value.
   */
  edit(key: string, shown: V, value: V): void {
    const newest = { seq: ++this.seq, value };
    const field = this.fields.get(key);
    if (field) field.newest = newest;
    else this.fields.set(key, { held: shown, since: newest.seq, newest });
  }

  /** A write of the field's newest value leaves: hand what this returns to `answered`. */
  sending(key: string): WriteTicket<V> | undefined {
    const field = this.fields.get(key);
    return field ? { ...field.newest } : undefined;
  }

  /**
   * The write `ticket` stands for came back, with `error` when it did not take. A failure stands
   * when nothing was set since: the field goes back to the value the console is known to hold, which
   * this returns. It returns undefined when the write took, or when a newer edit decides instead.
   */
  answered(key: string, ticket: WriteTicket<V> | undefined, error?: string): { value: V } | undefined {
    const field = this.fields.get(key);
    if (!ticket || !field || ticket.seq < field.since) return undefined;
    if (error === undefined) field.held = ticket.value;
    if (ticket.seq < field.newest.seq) return undefined;
    this.fields.delete(key);
    return error === undefined ? undefined : { value: field.held };
  }
}
