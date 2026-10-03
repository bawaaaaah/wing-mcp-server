# WING MCP menu bar app (macOS)

A small menu bar app that runs this checkout's server and keeps it running. It has no Dock icon.
Its menu can:

- **Start / Stop** the server (`node dist/index.js` in the checkout, with its state in `data/`),
- **Restart** it,
- **Rebuild & Restart**: runs `npm run build`. The running server keeps serving during the build
  and only restarts if the build succeeds. If it fails, an alert shows the end of the output.
- **Open Dashboard** (`http://localhost:<port>`) and **Open Public URL** (`server.publicUrl` from
  `data/config.json`, only shown when it is set),
- **Show Logs**: opens `data/prod.log` in Console. The server's output, the build output and the
  app's own `[menubar]` lines all go there.
- **Start Server When App Opens** (on by default) and **Open at Login**.

The server runs as a child of the app, so **quitting the app stops the server**. If node exits on its
own, the app restarts it after 1, 2, 5, then 10 s. After 5 exits within a minute it gives up and
shows *Crashed*.

If something else already answers `/health` on the port (for example a server you started by hand),
the menu shows *Running (external)* and disables Start, Stop and Restart. The app never signals a
process it did not start.

## Build and install

Needs the Xcode Command Line Tools (Swift 6) and node on your `PATH`:

```bash
macos/build-app.sh
```

The script builds `macos/build/WingMCP.app`, signs it ad hoc and copies it to
`~/Applications/WingMCP.app`. If the app was already running, the script relaunches it, and the new
copy takes over the server that is already running (through `data/menubar.pid`) instead of
restarting it.

The first time the server starts, macOS asks whether **WingMCP** may find devices on your local
network. Allow it, or the server cannot reach the console. If you missed the prompt, the setting is
in System Settings › Privacy & Security › Local Network.

Turn on **Open at Login** to start the app (and so the server) with your session. If macOS asks for
approval, the item shows a dash and opens System Settings › General › Login Items.

## Settings

The build bakes in the checkout's path and the `node` it found. Override them, or the port, with
`defaults`, then quit and reopen the app:

```bash
defaults write com.bawaaaaah.wing-mcp-menubar port -int 8787
defaults write com.bawaaaaah.wing-mcp-menubar nodePath /opt/homebrew/bin/node
defaults write com.bawaaaaah.wing-mcp-menubar repoPath ~/workspace/wing-mcp-server
```

`defaults delete com.bawaaaaah.wing-mcp-menubar <key>` goes back to the built-in value. The server
itself is configured as usual, through `data/config.json` and an optional `.env` in the checkout
(see [docs/configuration.md](../docs/configuration.md)).
