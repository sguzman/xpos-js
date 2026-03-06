# Tab Manipulation Roadmap

## Goal

Extend `xpose` from a read-only browser session bridge into a controlled tab management endpoint that can both inspect and manipulate tabs in the live Chromium session.

Target capabilities:

- [x] close tab
- [x] open tab
- [x] focus tab
- [x] move tab
- [x] group tabs
- [x] reload tab
- [x] query active/current tab state

## Scope

This roadmap covers:

- MV3 extension command support in [src/background.js](/win/linux/Code/web/extensions/xpos-js/src/background.js)
- HTTP API support in the external `browsr` server
- protocol updates between the HTTP server and extension
- operational constraints for live-session tab manipulation

This roadmap does not cover:

- bookmark management
- cross-profile control
- incognito session management
- non-Chromium browser support beyond current compatibility assumptions

## Constraints

- All actions happen against the live user session.
- Some actions can visibly affect the browser UI.
- Grouping support depends on Chromium `tabGroups` API availability.
- Discarded tabs may require wake/reload before some state reads are reliable.
- Privileged tabs such as `edge://*` remain restricted for DOM access, even if tab-level operations are allowed.

## API Additions

Add the following extension commands:

- [x] `close_tab`
- [x] `open_tab`
- [x] `focus_tab`
- [x] `move_tab`
- [x] `group_tabs`
- [x] `reload_tab`
- [x] `get_active_tab`
- [x] `get_tab_state`

Recommended HTTP surface in `browsr`:

- [x] `GET /v1/tabs/active`
- [x] `GET /v1/tabs/{tab_id}`
- [x] `POST /v1/tabs/open`
- [x] `POST /v1/tabs/{tab_id}/focus`
- [x] `POST /v1/tabs/{tab_id}/reload`
- [x] `POST /v1/tabs/{tab_id}/close`
- [x] `POST /v1/tabs/{tab_id}/move`
- [x] `POST /v1/tab-groups`

## Command Shapes

### `open_tab`

Request:

```json
{
  "command": "open_tab",
  "args": {
    "url": "https://example.com",
    "windowId": 1828091131,
    "active": true,
    "index": 3
  }
}
```

Response:

```json
{
  "id": "req-1",
  "ok": true,
  "result": {
    "tab": {
      "id": 123,
      "windowId": 77,
      "url": "https://example.com",
      "title": "Example Domain",
      "active": true
    }
  }
}
```

### `close_tab`

Request:

```json
{
  "command": "close_tab",
  "args": {
    "tabId": 123
  }
}
```

Response:

```json
{
  "id": "req-2",
  "ok": true,
  "result": {
    "closedTabId": 123
  }
}
```

### `focus_tab`

Request:

```json
{
  "command": "focus_tab",
  "args": {
    "tabId": 123
  }
}
```

Behavior:

- Focus the tab.
- Focus the containing window.
- Return the updated mapped tab payload.

### `move_tab`

Request:

```json
{
  "command": "move_tab",
  "args": {
    "tabId": 123,
    "index": 0,
    "windowId": 1828091131
  }
}
```

Behavior:

- If `windowId` differs from current window, move across windows.
- Return updated tab metadata.

### `group_tabs`

Request:

```json
{
  "command": "group_tabs",
  "args": {
    "tabIds": [123, 124, 125],
    "createProperties": {
      "windowId": 1828091131
    },
    "groupProperties": {
      "title": "Research",
      "color": "blue",
      "collapsed": false
    }
  }
}
```

Behavior:

- Create a new group or reuse a provided `groupId`.
- Apply title, color, and collapsed state.
- Return `groupId` plus normalized tab payloads.

### `reload_tab`

Request:

```json
{
  "command": "reload_tab",
  "args": {
    "tabId": 123,
    "bypassCache": false
  }
}
```

Response should return the current tab metadata after the reload request is issued. Optionally add a future `waitForComplete` flag.

### `get_active_tab`

Request:

```json
{
  "command": "get_active_tab",
  "args": {
    "windowId": 1828091131
  }
}
```

Behavior:

- Without `windowId`, return active tab from focused window.
- With `windowId`, return active tab for that specific window.

### `get_tab_state`

Return lightweight live state for a tab without doing DOM extraction:

- `active`
- `highlighted`
- `status`
- `discarded`
- `audible`
- `mutedInfo`
- `pinned`
- `groupId`
- `windowId`
- `index`
- `url`
- `title`

## Extension Changes

Add command handlers in [background.js](/win/linux/Code/web/extensions/xpos-js/src/background.js):

- [x] `open_tab`: use `chrome.tabs.create`
- [x] `close_tab`: use `chrome.tabs.remove`
- [x] `focus_tab`: use `chrome.tabs.update` and `chrome.windows.update`
- [x] `move_tab`: use `chrome.tabs.move`
- [x] `group_tabs`: use `chrome.tabs.group` and `chrome.tabGroups.update`
- [x] `reload_tab`: use `chrome.tabs.reload`
- [x] `get_active_tab`: use `chrome.tabs.query({ active: true, ... })`
- [x] `get_tab_state`: use `chrome.tabs.get`

Manifest updates likely required:

- [x] add `"tabGroups"` permission if grouping is implemented directly

Implementation notes:

- Reuse existing `mapTab` output to keep response shape stable.
- Normalize both camelCase and snake_case request args.
- Log each mutating action with trace IDs and affected tab IDs.
- For operations that can change focus, emit explicit event logs before and after mutation.

## Browsr Changes

Add matching REST endpoints and request models in `browsr`:

- parse JSON payloads into the extension command envelopes already used by `/v1/tabs/{tab_id}/snapshot`
- keep request timeout short for pure tab actions
- return normalized tab payloads to clients

Recommended server behavior:

- `open`, `focus`, `move`, `reload`, `close`, and `group` should bypass tab cache and update cache from the extension response
- `get_active_tab` should support a zero-body GET endpoint
- `get_tab_state` should be usable for quick polling without full refresh

## Phases

### Phase 1: Safe Single-Tab Actions

Implement first:

- [x] `get_active_tab`
- [x] `get_tab_state`
- [x] `focus_tab`
- [x] `reload_tab`
- [x] `close_tab`
- [x] `open_tab`

Reason:

- low protocol risk
- low ambiguity
- immediately useful for automation clients

### Phase 2: Positional Control

Implement:

- [x] `move_tab`

Reason:

- introduces cross-window semantics and index handling
- should be done after tab identity and focus flows are stable

### Phase 3: Grouping

Implement:

- [x] `group_tabs`

Reason:

- requires extra permission surface
- response model is more complex
- group lifecycle should be designed deliberately

## Validation Plan

For the extension:

- [ ] verify command success for active and background tabs
- [ ] verify focus restore behavior does not regress snapshot flow
- [ ] verify move across windows preserves expected index
- [ ] verify group creation returns stable `groupId`

For `browsr`:

- [ ] add integration tests per endpoint
- [ ] assert the server returns `502` only on extension command failure
- [ ] assert command timeouts stay below configured request timeout budget

Manual tests:

- [ ] Open a tab into a target window and verify returned `tab.id`.
- [ ] Focus a background tab and verify window focus changes.
- [ ] Move a tab to index `0` and confirm ordering.
- [ ] Group three tabs and verify color/title in Edge.
- [ ] Reload a discarded tab and query state until `status=complete`.
- [ ] Close a tab and confirm subsequent `get_tab_state` fails cleanly.

## Risks

- Focusing or waking tabs can visibly disrupt the user.
- Moving tabs across windows can invalidate stale client-side indices.
- Group operations may differ slightly across Chromium variants.
- Active-tab queries are inherently race-prone if the user is interacting while automation runs.

## Recommended Order

Build in this order:

- [x] `get_active_tab`
- [x] `get_tab_state`
- [x] `focus_tab`
- [x] `reload_tab`
- [x] `open_tab`
- [x] `close_tab`
- [x] `move_tab`
- [x] `group_tabs`

This order minimizes protocol churn and gives clients useful control quickly.
