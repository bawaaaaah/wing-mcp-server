import { useState, type JSX } from "react";
import { useGroupMembers, useToggleGroup, type GroupMemberKind, type WingMixerState } from "../api/queries.js";
import { wingColorHex } from "../components/ParamPanel.js";

const SECTIONS: readonly { type: GroupMemberKind; list: keyof WingMixerState; title: string; one: string; short: string }[] = [
  { type: "channel", list: "channels", title: "Channels", one: "Channel", short: "Ch" },
  { type: "aux", list: "auxes", title: "Aux", one: "Aux", short: "Aux" },
  { type: "bus", list: "buses", title: "Buses", one: "Bus", short: "Bus" },
  { type: "main", list: "mains", title: "Mains", one: "Main", short: "Main" },
  { type: "mtx", list: "matrices", title: "Matrices", one: "Matrix", short: "Mtx" },
];

/**
 * Who is in a mute group or a DCA, edited the way solo safe is: pick the group, then every strip is a
 * chip in its colour, lit while it belongs. A click adds or removes it (the strip's `#Mn`/`#Dn` tag).
 */
export function GroupMembersEditor({
  group,
  groups,
  state,
}: {
  group: "mutegroup" | "dca";
  groups: readonly { index: number; name: string }[];
  state: WingMixerState;
}): JSX.Element {
  const [selected, setSelected] = useState(() => groups.find((g) => g.name)?.index ?? 1);
  const members = useGroupMembers();
  const toggle = useToggleGroup();
  // Shown at once; the console's answer then replaces it in the members list.
  const [pending, setPending] = useState<Map<string, boolean>>(new Map());
  const noun = group === "dca" ? "DCA" : "Mute group";
  const current = members.data?.[group === "dca" ? "dca" : "mutegroups"][selected] ?? [];

  const isMember = (type: GroupMemberKind, index: number) =>
    pending.get(`${selected}:${type}:${index}`) ?? current.some((m) => m.type === type && m.index === index);

  function flip(type: GroupMemberKind, index: number) {
    const key = `${selected}:${type}:${index}`;
    const on = !isMember(type, index);
    setPending((prev) => new Map(prev).set(key, on));
    toggle.mutate(
      { kind: type, index, group, groupIndex: selected, on },
      {
        onSettled: () =>
          setPending((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          }),
      },
    );
  }

  const groupLabel = (g: { index: number; name: string }) => `${g.index}${g.name ? ` · ${g.name}` : ""}`;

  return (
    <div className="mixer-stage-group group-editor">
      <div className="mixer-processing-card__header">
        <h3>{noun} members</h3>
        <span className="card-hint">{current.length} in this group</span>
      </div>
      <div className="group-editor__picker" role="group" aria-label={`${noun} to edit`}>
        {groups.map((g) => (
          <button
            key={g.index}
            type="button"
            className="segmented__option"
            aria-pressed={selected === g.index}
            onClick={() => setSelected(g.index)}
          >
            {groupLabel(g)}
          </button>
        ))}
      </div>
      {members.isError && <p className="error">{(members.error as Error).message}</p>}
      {!members.data && !members.isError && <p className="card-hint">Reading every strip's groups…</p>}
      {members.data &&
        SECTIONS.map(({ type, list, title, one, short }) => (
          <div key={type}>
            <h4 className="safe-chips__title">{title}</h4>
            <div className="safe-chips">
              {(state[list] as { index: number; name: string; col: number }[]).map((strip) => {
                const on = isMember(type, strip.index);
                const hex = wingColorHex(strip.col);
                return (
                  <button
                    key={strip.index}
                    type="button"
                    className={on ? "safe-chip safe-chip--on" : "safe-chip"}
                    style={hex ? { borderLeftColor: hex } : undefined}
                    aria-pressed={on}
                    title={`${one} ${strip.index}${on ? ` — in ${noun.toLowerCase()} ${selected}` : ""}`}
                    onClick={() => flip(type, strip.index)}
                  >
                    {strip.name || `${short} ${strip.index}`}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      {toggle.isError && <p className="error">{toggle.error.message}</p>}
    </div>
  );
}
