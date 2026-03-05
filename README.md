# xpose

MV3 extension for Edge/Chromium that exposes live tab and window introspection to a local self-hosted server over WebSocket.

## What it does

- Streams live tab/window events across all browser windows.
- Handles server commands to list windows, list tabs, and snapshot a tab's DOM/HTML/text.
- Uses structured trace logging with timestamps and trace IDs for all lifecycle, socket, and command operations.
- Provides an options page for runtime config.

## Local protocol

The extension connects to `ws://127.0.0.1:17373/ws` by default and sends:

- `hello`: initial state including windows/tabs.
- `event`: live updates (`tab.created`, `tab.updated`, `window.focus_changed`, etc).
- `response`: command result envelope.
- `log`: structured trace logs from extension internals.

Server commands should be JSON messages:

```json
{
  "type": "command",
  "id": "req-1",
  "traceId": "external-trace-id",
  "command": "list_tabs",
  "args": {}
}
```

Supported commands:

- `ping`
- `get_state`
- `list_windows`
- `list_tabs`
- `snapshot_tab`
- `set_config`

## Build

```bash
npm run check
npm run build
```

Build output is copied to `dist/xpose`.

## Load in Edge

1. Open `edge://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked` and select `dist/xpose`.
4. In extension details, set site access to `On all sites`.
5. Start your local WebSocket server on `127.0.0.1`.

## Notes

- Works across all tabs in all normal browser windows within the same profile.
- `edge://*` and other privileged pages are restricted by browser policy.
- Snapshot payload size is capped by `maxHtmlBytes` and `maxTextBytes`.
