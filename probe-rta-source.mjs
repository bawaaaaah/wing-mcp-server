import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
  requestInit: { headers: { Authorization: "Bearer oCxNm1A0jyew8Sc75R2UiHKQ5hyUDIEp" } },
});
const client = new Client({ name: "probe", version: "1.0.0" });
await client.connect(transport);

console.log("--- wing_get /cfg/rta (branch listing) ---");
const branch = await client.callTool({ name: "wing_get", arguments: { path: "/cfg/rta" } });
console.log(JSON.stringify(branch.structuredContent));

console.log("--- wing_describe /cfg/rta with values ---");
const desc = await client.callTool({ name: "wing_describe", arguments: { path: "/cfg/rta", includeValues: true } });
console.log(desc.content[0].text);

await client.close();
