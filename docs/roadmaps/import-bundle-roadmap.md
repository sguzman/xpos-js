# Import Bundle Roadmap

## Goal

Add a second, heavier retrieval mode to `xpose` that captures a tab as a reconstructable import bundle.

The extension should support two different products:

- [x] `snapshot`: fast tab inspection for title, URL, HTML, text, selection, and quick state
- [x] `import-bundle`: debugger-backed, reload-driven capture for a near-faithful recreation of the tab and the assets it loaded

## Product Split

### `snapshot`

Purpose:

- [x] cheap and fast
- [x] minimal browser disruption
- [x] best-effort HTML/text extraction
- [x] suitable for reading, indexing, previews, and lightweight import flows

Current behavior:

- [x] query tab/window metadata
- [x] capture HTML/text/selection
- [x] wake or reload sleeping tabs when needed
- [x] tolerate transient restored-tab failures with retry logic

### `import-bundle`

Purpose:

- [x] intentionally heavy
- [x] explicit user-requested archival/import operation
- [x] reload the tab and record page assets during load
- [x] return enough data for downstream consumers to recreate the tab without new HTML or asset requests to origin

## Target Outcome

Given a tab ID, downstream consumers should be able to request:

- [x] final HTML document
- [x] asset manifest for the tab
- [x] asset bodies already observed by the browser during reload
- [x] metadata required to rewrite asset references to local or consumer-hosted bundle URLs
- [x] optional screenshot for verification/debugging

## Hard Constraint

There is no clean MV3 extension API that says “give me arbitrary bytes from browser cache for this URL.”

The viable path is:

- [x] use `chrome.debugger`
- [x] attach to the live tab
- [x] enable CDP `Network` and `Page`
- [x] reload the page
- [x] record resource requests and bodies during the reload
- [x] build a bundle from what was actually loaded

This is a debugger-backed capture system, not a general browser-cache dump API.

## Scope

This roadmap covers:

- [x] debugger-based capture in [src/background.js](/win/linux/Code/web/extensions/xpos-js/src/background.js)
- [x] manifest permission updates in [manifest.json](/win/linux/Code/web/extensions/xpos-js/manifest.json)
- [x] command protocol additions exposed by the extension
- [x] in-memory capture job state inside the extension
- [x] bundle schema emitted by the extension

This roadmap does not cover:

- [ ] consumer HTTP API design
- [ ] consumer storage or persistence strategy
- [ ] consumer-side HTML rewriting pipeline
- [ ] perfect replay of authenticated app state
- [ ] full-service-worker emulation
- [ ] browser-global cache export
- [ ] non-Chromium browser parity beyond current assumptions

## UX / Operational Tradeoffs

- [x] the tab will reload during import-bundle capture
- [x] dynamic pages may not replay identically after reload
- [x] debugger attachment may show browser UX/warnings depending on Chromium behavior
- [x] long imports can consume significant memory
- [ ] large pages with many assets need a future persistence/export strategy outside the extension worker

## High-Level Architecture

### Extension responsibilities

- [x] attach debugger to a requested tab
- [x] enable `Network` and `Page`
- [x] start a tab-scoped capture session
- [x] reload the tab
- [x] collect resource metadata and bodies while the page loads
- [x] capture final HTML after load settles
- [x] detach debugger when the session completes or fails

### Downstream consumer responsibilities

- [ ] request an import bundle explicitly
- [ ] poll job state or listen for progress through its own transport
- [ ] consume a manifest plus extension-provided asset records instead of re-fetching origin assets
- [ ] optionally persist captured assets outside the extension

## Command Surface

### Lightweight path

- [x] `snapshot_tab`

### Heavy import path

- [x] `start_import_bundle`
- [x] `get_import_bundle_status`
- [x] `get_import_bundle_manifest`
- [x] `get_import_bundle_asset`
- [x] `cancel_import_bundle`

## Recommended Import Request Shape

### `start_import_bundle`

```json
{
  "tabId": 1828093415,
  "reload": true,
  "captureHtml": true,
  "captureAssets": true,
  "captureText": true,
  "captureScreenshot": false,
  "waitForNetworkIdleMs": 1500,
  "maxAssetBytes": 25000000,
  "maxTotalBytes": 200000000
}
```

### Initial response

Return a job envelope immediately rather than blocking the caller for the full bundle:

```json
{
  "jobId": "imp_01JXYZ...",
  "tabId": 1828093415,
  "status": "running"
}
```

### Completed manifest

```json
{
  "jobId": "imp_01JXYZ...",
  "status": "completed",
  "bundle": {
    "tab": {
      "id": 1828093415,
      "title": "Example",
      "url": "https://example.com/page"
    },
    "document": {
      "contentType": "text/html",
      "html": "<!doctype html>..."
    },
    "assets": [
      {
        "assetId": "asset_001",
        "url": "https://example.com/app.css",
        "resourceType": "Stylesheet",
        "mimeType": "text/css",
        "status": 200,
        "servedFromCache": true,
        "base64Encoded": false,
        "bytes": 18342
      }
    ]
  }
}
```

## Manifest / Permission Changes

- [x] add `"debugger"` permission to [manifest.json](/win/linux/Code/web/extensions/xpos-js/manifest.json)
- [x] keep existing host permissions for normal scripting paths
- [x] document debugger-related UX implications in [README.md](/win/linux/Code/web/extensions/xpos-js/README.md)

## Extension Command Additions

Add new extension commands:

- [x] `start_import_bundle`
- [x] `get_import_bundle_status`
- [x] `get_import_bundle_manifest`
- [x] `get_import_bundle_asset`
- [x] `cancel_import_bundle`

## Extension Implementation Plan

### Phase 1: Session Lifecycle

- [x] add an in-memory import session registry keyed by `jobId`
- [x] store session state: `queued | attaching | reloading | capturing | finalizing | completed | failed | cancelled`
- [x] attach debugger with `chrome.debugger.attach`
- [x] enable `Network`
- [x] enable `Page`
- [x] register debugger event handlers keyed by tab/session
- [x] detach cleanly on completion, timeout, cancellation, or tab close

### Phase 2: Network Recording

- [x] listen for `Network.requestWillBeSent`
- [x] listen for `Network.responseReceived`
- [x] listen for `Network.loadingFinished`
- [x] listen for `Network.loadingFailed`
- [x] listen for `Network.requestServedFromCache`
- [x] maintain per-request state keyed by `requestId`

Per recorded request, track:

- [x] request URL
- [x] document/frame association
- [x] initiator
- [x] resource type
- [x] status code
- [x] mime type
- [x] headers
- [x] cache-served flag
- [x] encoded data length
- [x] body retrieval state

### Phase 3: Body Retrieval

- [x] fetch response bodies with `Network.getResponseBody` after `loadingFinished`
- [x] mark whether a body is base64 encoded
- [x] support binary assets such as images/fonts
- [x] skip or truncate assets larger than configured thresholds
- [x] keep failure metadata when a body cannot be retrieved

### Phase 4: Page Finalization

- [x] wait for `Page.loadEventFired`
- [x] wait for configurable network-idle window
- [x] capture final HTML using the existing snapshot extraction path or a debugger-backed fallback
- [x] optionally capture final text snapshot
- [x] optionally capture visible screenshot

### Phase 5: Bundle Assembly

- [x] normalize asset entries into a stable manifest
- [x] generate deterministic `asset_id` values
- [x] include tab metadata and capture timing metadata
- [x] store manifest and asset bodies in memory inside the extension
- [x] add a formal export shape for downstream consumers that need deterministic replay metadata

## Extension Limits

- [x] add configurable per-import size budgets through extension config
- [x] add cleanup/eviction policies for completed jobs
- [x] add optional chunked asset retrieval for very large payloads
- [x] add optional screenshot compression controls

## Failure Modes To Handle Explicitly

- [x] debugger attach denied
- [x] tab closed during import
- [x] reload failed
- [x] page never reached network idle
- [x] response body unavailable for some requests
- [x] size budget exceeded
- [x] cross-origin subresources missing body
- [x] client cancelled import

## Error Codes

Recommended extension error codes:

- [x] `IMPORT_BUNDLE_ATTACH_FAILED`
- [x] `IMPORT_BUNDLE_TIMEOUT`
- [x] `IMPORT_BUNDLE_CANCELLED`
- [x] `IMPORT_BUNDLE_RELOAD_FAILED`
- [x] `IMPORT_BUNDLE_BODY_UNAVAILABLE`
- [x] `IMPORT_BUNDLE_SIZE_LIMIT_EXCEEDED`
- [x] `HOST_PERMISSION_DENIED`
- [x] `UNSUPPORTED_TAB_URL`

## Validation Plan

### Extension validation

- [ ] verify debugger attach/detach for ordinary `https://` pages
- [ ] verify one import job per tab at a time
- [ ] verify sleeping/discarded tabs wake and reload correctly
- [ ] verify grouped tabs behave no differently than normal tabs
- [ ] verify capture completes for pages with many assets

### Manual tests

- [ ] import a simple static page with CSS and images
- [ ] import a large article page with many referenced assets
- [ ] import a tab from a restored session window
- [ ] import a grouped tab
- [ ] import a page with lazy-loaded images
- [ ] import a page with fonts and external stylesheets
- [ ] verify a downstream consumer can render from the captured bundle without origin requests

## Rollout Order

- [x] add debugger permission and attach lifecycle
- [x] add basic import job commands
- [x] record network events
- [x] fetch asset bodies
- [x] capture final HTML
- [x] expose manifest and asset retrieval commands
- [x] add cleanup policies
- [x] add export-oriented replay metadata

## Recommendation

Build `import-bundle` as an explicit archival/import workflow, not as an extension of `snapshot`.

That means:

- [x] keep `snapshot` fast, cheap, and best-effort
- [x] keep `import-bundle` explicit, debugger-backed, reload-driven, and long-running
- [x] treat bundle capture as a job, not a single synchronous response

This separation keeps the lightweight tab-inspection path stable while letting the extension support a heavier capture mode when explicitly requested.
