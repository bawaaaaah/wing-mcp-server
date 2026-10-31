/**
 * What a describe-driven panel (ParamPanel) shows ahead of the console while its writes travel, and
 * why a write did not take. A field the user sets shows the new value until the console is read
 * again after that write came back, so a value the console clamped, snapped or replaced never
 * outlives the next read; a write that did not take rolls its field back at once. Plain
 * bookkeeping with no React in it, so the rules can be tested on their own.
 */

export type ParamValue = number | string;

/** The part of a write route's answer (the console's WingAck) that says whether it took. */
export interface WriteAck {
  ok: boolean;
  status: string;
}

export class ParamEdits {
  private seq = 0;
  /** The value each field the user set shows, and the number of that edit. */
  private readonly edits = new Map<string, { value: ParamValue; seq: number }>();
  /** Writes on their way, by field. */
  private readonly inFlight = new Map<string, number>();
  /** The newest edit whose write has come back, by field. */
  private readonly answeredUpTo = new Map<string, number>();
  private readonly errors = new Map<string, string>();

  /** The user set a field: show `value` until the console has been read after it is written. */
  edit(key: string, value: ParamValue): void {
    this.edits.set(key, { value, seq: ++this.seq });
    this.errors.delete(key);
  }

  /** Whether the field shows a value of its own rather than the console's. */
  isEdited(key: string): boolean {
    return this.edits.has(key);
  }

  /** A write of the field's current value leaves; hand the number it returns to `answered`. */
  sending(key: string): number {
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    return this.edits.get(key)?.seq ?? this.seq;
  }

  /**
   * The write `sending` numbered `seq` came back, with `error` when it did not take. A failed write
   * puts the field back on the console's value, unless the user has set it again since.
   */
  answered(key: string, seq: number, error?: string): void {
    const left = (this.inFlight.get(key) ?? 1) - 1;
    if (left > 0) this.inFlight.set(key, left);
    else this.inFlight.delete(key);
    this.answeredUpTo.set(key, Math.max(this.answeredUpTo.get(key) ?? 0, seq));
    if (error === undefined) {
      this.errors.delete(key);
      return;
    }
    this.errors.set(key, error);
    if (this.isSettled(key)) this.edits.delete(key);
  }

  /** Whether a write is still on its way. */
  get busy(): boolean {
    return this.inFlight.size > 0;
  }

  /**
   * The console's values were just read: every edit whose write has come back gives way to them.
   * An edit not written yet (a slider's throttled value, text still being typed) or still in flight
   * stays. Returns whether anything changed.
   */
  consoleRead(): boolean {
    let changed = false;
    for (const key of [...this.edits.keys()]) {
      if (this.isSettled(key)) {
        this.edits.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  /** Forgets every other field's edit and error: they were set under a model no longer loaded. */
  keepOnly(key: string): void {
    for (const other of [...this.edits.keys()]) if (other !== key) this.edits.delete(other);
    for (const other of [...this.errors.keys()]) if (other !== key) this.errors.delete(other);
  }

  /** The panel's values as shown: the console's, with the user's edits over them. */
  shown(values: Readonly<Record<string, ParamValue>>): Record<string, ParamValue> {
    const result = { ...values };
    for (const [key, edit] of this.edits) result[key] = edit.value;
    return result;
  }

  /** Why the field's last write did not take, until the user sets it again. */
  error(key: string): string | undefined {
    return this.errors.get(key);
  }

  private isSettled(key: string): boolean {
    const edit = this.edits.get(key);
    return edit !== undefined && !this.inFlight.has(key) && (this.answeredUpTo.get(key) ?? 0) >= edit.seq;
  }
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
