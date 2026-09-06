import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { COLOR_DESCRIPTION, ICON_DESCRIPTION } from "../wing-param-catalog.js";
import { getSourceProps, setSourceProps } from "../wing-source.js";
import type { WingPluginContext } from "../wing-plugin.js";
import { textResult, wrapWingTool } from "./generic.js";

export function registerSourceTools(server: McpServer, ctx: WingPluginContext): void {
  server.registerTool(
    "wing_get_source",
    {
      title: "Wing: Get physical input source properties",
      description:
        "Reads a physical input source's own console-surface identity and preamp settings — name, color, " +
        "icon, gain trim (dB), 48V phantom, polarity, and mute — for a source such as Local In 3 " +
        '(group "LCL", index 3) or AES50-A port 7 (group "A", index 7). Group names vary by console model ' +
        "and are the same groups a channel/aux input is patched from (LCL, AUX, A, B, C, SC, USB, CRD, AES, " +
        "...); an unknown group is rejected by the console. A field that does not exist for the group " +
        "(e.g. 48V on a digital input) comes back as null.",
      inputSchema: {
        group: z.string().min(1),
        index: z.number().int().min(1),
      },
    },
    ({ group, index }) =>
      wrapWingTool(async () => {
        const props = await getSourceProps(ctx, group, index);
        const colorText = props.colorName ? `${props.col} (${props.colorName})` : String(props.col);
        const iconText = props.iconName ? `${props.icon} (${props.iconName})` : String(props.icon);
        return {
          content: [
            textResult(
              `${group}${index} source: name="${props.name}", col=${colorText}, icon=${iconText}, ` +
                `gain=${props.gain ?? "n/a"}, 48V=${props.phantom48v ?? "n/a"}, ` +
                `polarity=${props.polarityInverted ?? "n/a"}, mute=${props.mute ?? "n/a"}`,
            ),
          ],
          structuredContent: { ...props },
        };
      }),
  );

  server.registerTool(
    "wing_set_source",
    {
      title: "Wing: Set physical input source properties",
      description:
        "Sets any subset of a physical input source's name, color, icon, gain trim (dB), 48V phantom, " +
        "polarity, and mute — the same identity you assign to a channel/bus strip with wing_set_scribble, " +
        'but on the physical input itself (e.g. group "LCL" index 3 for Local In 3, group "A" index 7 for ' +
        "AES50-A port 7). This is what a channel/aux displays when its name/customization is linked to its " +
        "source. Group names vary by console model; an unknown group — or 48V on a group with no phantom " +
        `power — is rejected by the console. Color palette: ${COLOR_DESCRIPTION}. Icon set: ${ICON_DESCRIPTION}.`,
      inputSchema: {
        group: z.string().min(1),
        index: z.number().int().min(1),
        name: z.string().max(24).optional(),
        col: z.number().int().min(1).max(18).optional(),
        icon: z.number().int().min(0).max(999).optional(),
        gain: z.number().optional(),
        phantom48v: z.boolean().optional(),
        polarityInverted: z.boolean().optional(),
        mute: z.boolean().optional(),
      },
    },
    ({ group, index, name, col, icon, gain, phantom48v, polarityInverted, mute }) =>
      wrapWingTool(async () => {
        const result = await setSourceProps(ctx, {
          group,
          index,
          name,
          col,
          icon,
          gain,
          phantom48v,
          polarityInverted,
          mute,
        });
        return {
          content: [textResult(`${group}${index} source updated: ${result.ack.status}`)],
          structuredContent: { ...result },
        };
      }),
  );
}
