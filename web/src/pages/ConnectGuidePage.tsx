import { useState } from "react";
import { getToken } from "../auth/token-store.js";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail (permissions, non-secure context) — the text is still selectable
      // in the code block itself, so there's nothing more useful to do here than stay silent.
    }
  }

  return (
    <button type="button" className="copy-button" onClick={copy}>
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="code-block">
      <pre>
        <code>{code}</code>
      </pre>
      <CopyButton text={code} />
    </div>
  );
}

/**
 * The token is this browser's own already-authenticated session token (TokenGate required it to
 * render this page at all) — not a foreign secret — so embedding it directly into copy-pasteable
 * commands is intentional. It's masked by default purely as a shoulder-surfing/screen-share
 * safeguard, not because the value is untrusted here.
 */
export function ConnectGuidePage() {
  const token = getToken() ?? "";
  const [revealed, setRevealed] = useState(false);
  const mcpUrl = `${window.location.origin}/mcp`;
  const maskedToken = "•".repeat(Math.min(token.length, 24) || 24);

  const claudeCodeCmd = `claude mcp add --transport http --header "Authorization: Bearer ${token}" wing ${mcpUrl}`;
  const hermesYaml = `mcp_servers:\n  wing:\n    url: "${mcpUrl}"\n    headers:\n      Authorization: "Bearer ${token}"`;
  const inspectorCmd = "npx @modelcontextprotocol/inspector";
  const curlCmd = `curl -X POST "${mcpUrl}" \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;

  return (
    <div className="page">
      <h2>Connect an MCP client</h2>
      <p>
        This server speaks standard MCP (Model Context Protocol) over Streamable HTTP. Any MCP-compatible client can
        control the Wing console through it once it has the endpoint URL and access token below.
      </p>

      <section className="card">
        <h3>Your connection details</h3>
        <dl className="kv-list">
          <dt>Endpoint URL</dt>
          <dd>
            <code>{mcpUrl}</code> <CopyButton text={mcpUrl} />
          </dd>
          <dt>Access token</dt>
          <dd>
            <code>{revealed ? token : maskedToken}</code>{" "}
            <button type="button" className="mixer-mute" onClick={() => setRevealed((r) => !r)}>
              {revealed ? "Hide" : "Reveal"}
            </button>{" "}
            <CopyButton text={token} />
          </dd>
        </dl>
        <p className="meters-status">
          Every request to this endpoint needs an <code>Authorization: Bearer &lt;token&gt;</code> header — there's no
          other way to authenticate, and no query-param fallback for <code>/mcp</code> itself.
        </p>
      </section>

      <section className="card">
        <h3>Claude Code (CLI)</h3>
        <p>Run once, from any directory:</p>
        <CodeBlock code={claudeCodeCmd} />
        <p className="meters-status">
          Add <code>--scope user</code> to make it available in every project instead of just the current one. Check{" "}
          <code>claude mcp add --help</code> if this flag set doesn't match your installed CLI version. Verify with{" "}
          <code>claude mcp list</code>.
        </p>
      </section>

      <section className="card">
        <h3>Claude Desktop</h3>
        <ol>
          <li>
            Open <strong>Settings → Connectors → Add custom connector</strong>.
          </li>
          <li>Paste the endpoint URL above.</li>
          <li>
            In the <strong>Request headers</strong> section, add a header named <code>Authorization</code> with value{" "}
            <code>Bearer {revealed ? token : "<token>"}</code>.
          </li>
        </ol>
        <p className="meters-status">Custom request headers for remote connectors are a newer Claude Desktop feature — if you don't see that section, update the app.</p>
      </section>

      <section className="card">
        <h3>Witsy</h3>
        <ol>
          <li>
            Open <strong>Connectors</strong> from the app's menu bar, then click <strong>Add MCP server…</strong>.
          </li>
          <li>
            Set <strong>Type</strong> to <strong>Streamable HTTP</strong> and paste the endpoint URL above.
          </li>
          <li>
            In the <strong>Custom HTTP Headers</strong> table that appears, add a row: key <code>Authorization</code>,
            value <code>Bearer {revealed ? token : "<token>"}</code>.
          </li>
          <li>Save.</li>
        </ol>
        <p className="meters-status">
          Witsy's "Import from JSON" button only accepts local stdio-style entries (<code>command</code>/<code>args</code>) —
          add the header through the key/value table above, not that importer.
        </p>
      </section>

      <section className="card">
        <h3>Hermes (Nous Research)</h3>
        <p>
          Add an entry under <code>mcp_servers</code> in <code>~/.hermes/config.yaml</code>:
        </p>
        <CodeBlock code={hermesYaml} />
        <p className="meters-status">
          Then run <code>/reload-mcp</code> in an active chat session (or restart Hermes) to pick it up. The CLI, TUI,
          and desktop app all read this same config file.
        </p>
      </section>

      <section className="card">
        <h3>claude.ai (web)</h3>
        <p className="error">
          Not supported yet: claude.ai's remote connectors currently only support OAuth, not custom headers, so a
          bearer-token server like this one can't be added there directly. Use Claude Code or Claude Desktop instead.
        </p>
      </section>

      <section className="card">
        <h3>MCP Inspector (for testing/debugging)</h3>
        <CodeBlock code={inspectorCmd} />
        <p>
          In the Inspector's UI, choose transport <strong>Streamable HTTP</strong>, paste the endpoint URL, and add
          the same <code>Authorization</code> header as above.
        </p>
      </section>

      <section className="card">
        <h3>Raw HTTP</h3>
        <p>For scripting or any client without built-in MCP support:</p>
        <CodeBlock code={curlCmd} />
      </section>
    </div>
  );
}
