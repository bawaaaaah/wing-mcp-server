import { useMemo, useRef, useState } from "react";
import type { WingAck } from "./queries.js";
import { OptimisticWrites, writeOutcome } from "./optimistic-writes.js";

export interface OptimisticWriter<V> {
  /** Shows `value` at once; `shown` is what the field showed until now. */
  edit: (key: string, shown: V, value: V) => void;
  /** Sends the field's newest value; `what` names it in the report when it does not take ("Ch 3 mute"). */
  send: (key: string, what: string, write: Promise<WingAck>) => void;
}

/**
 * A control's writes shown ahead of the console (see OptimisticWrites): `show` applies a value to
 * the screen, and is called again with the console's when the newest write does not take, which
 * `report` then says. A throttled control edits on every move and sends from its throttle.
 */
export function useOptimisticWrites<V>(show: (value: V) => void, report: (message: string) => void): OptimisticWriter<V> {
  const [writes] = useState(() => new OptimisticWrites<V>());
  const latest = useRef({ show, report });
  latest.current = { show, report };

  return useMemo(
    () => ({
      edit: (key, shown, value) => {
        writes.edit(key, shown, value);
        latest.current.show(value);
      },
      send: (key, what, write) => {
        const ticket = writes.sending(key);
        void writeOutcome(write).then((error) => {
          const back = writes.answered(key, ticket, error);
          if (back) latest.current.show(back.value);
          if (error !== undefined && (back || !ticket)) latest.current.report(`${what} — ${error}`);
        });
      },
    }),
    [writes],
  );
}
