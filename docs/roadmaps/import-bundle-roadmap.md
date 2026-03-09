# Import Bundle Roadmap

## Goal

Add a second, heavier retrieval mode to `xpose` and `browsr` that captures a tab as a reconstructable import bundle.

The system should support two different products:

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
- [x] return enough data for downstream clients to recreate the tab without new HTML or asset requests to origin

## Target Outcome

Given a tab ID, downstream clients should be able to request:

- [x] final HTML document
- [x] asset manifest for the tab
- [x] asset bodies already observed by the browser during reload
- [x] metadata required to rewrite asset references to local or server-hosted bundle URLs
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
- [x] new `browsr` endpoints and request models in [api.rs](/win/linux/Code/web/extensions/xpos-js/tmp/browsr/src/api.rs)
- [x] capture job state and timeout handling in `browsr`
- [x] bundle schema for downstream clients

This roadmap does not cover:

- [ ] perfect replay of authenticated app state
- [ ] full-service-worker emulation
- [ ] browser-global cache export
- [ ] non-Chromium browser parity beyond current assumptions

## UX / Operational Tradeoffs

- [x] the tab will reload during import-bundle capture
- [x] dynamic pages may not replay identically after reload
- [x] debugger attachment may show browser UX/warnings depending on Chromium behavior
- [x] long imports can consume significant memory
- [ ] large pages with many assets need streaming or persistence, not one giant in-memory payload

## High-Level Architecture

### Extension responsibilities

- [x] attach debugger to a requested tab
- [x] enable `Network` and `Page`
- [x] start a tab-scoped capture session
- [x] reload the tab
- [x] collect resource metadata and bodies while the page loads
- [x] capture final HTML after load settles
- [x] detach debugger when the session completes or fails

### `browsr` responsibilities

- [x] expose a heavy import endpoint separate from `snapshot`
- [x] manage long-running capture jobs
- [x] stream or stage bundle content
- [x] serve captured asset bytes to clients
- [ ] optionally persist bundles to disk

### GUI client responsibilities

- [ ] request an import bundle explicitly
- [ ] show progress / loading state
- [ ] consume a manifest plus local bundle URLs instead of re-fetching origin assets

## Recommended API Surface

### Lightweight path

- [x] `POST /v1/tabs/{tab_id}/snapshot`

### Heavy import path

- [x] `POST /v1/tabs/{tab_id}/import-bundle`
- [x] `GET /v1/import-jobs/{job_id}`
- [x] `GET /v1/import-jobs/{job_id}/manifest`
- [x] `GET /v1/import-jobs/{job_id}/assets/{asset_id}`
- [x] `DELETE /v1/import-jobs/{job_id}`

## Recommended Request Shape

### `POST /v1/tabs/{tab_id}/import-bundle`

```json
{
  "reload": true,
  "capture_html": true,
  "capture_assets": true,
  "capture_text": true,
  "capture_screenshot": false,
  "wait_for_network_idle_ms": 1500,
  "max_asset_bytes": 25000000,
  "max_total_bytes": 200000000
}
```

### Initial response

Return a job envelope immediately rather than blocking the HTTP request for the full bundle:

```json
{
  "ok": true,
  "job_id": "imp_01JXYZ...",
  "tab_id": 1828093415,
  "status": "running"
}
```

### Completed manifest

```json
{
  "ok": true,
  "job_id": "imp_01JXYZ...",
  "status": "completed",
  "bundle": {
    "tab": {
      "id": 1828093415,
      "title": "Example",
      "url": "https://example.com/page"
    },
    "document": {
      "content_type": "text/html",
      "encoding": "utf-8",
      "html": "<!doctype html>..."
    },
    "assets": [
      {
        "asset_id": "asset_001",
        "url": "https://example.com/app.css",
        "resource_type": "Stylesheet",
        "mime_type": "text/css",
        "status": 200,
        "served_from_cache": true,
        "base64_encoded": false,
        "bytes": 18342,
        "body_url": "/v1/import-jobs/imp_01JXYZ/assets/asset_001"
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
- [x] include rewritten local body URLs for downstream clients
- [x] include tab metadata and capture timing metadata
- [x] store manifest and asset bodies in memory or on disk

## `browsr` Server Changes

### New config

- [x] add `import_bundle_timeout_ms`
- [ ] add `import_bundle_max_asset_bytes`
- [ ] add `import_bundle_max_total_bytes`
- [ ] add optional on-disk bundle storage root

### New API models

- [x] request model for `import-bundle`
- [x] status response model
- [x] manifest response model
- [x] asset streaming/download response
- [x] structured error models for debugger attach failures, timeout, and body truncation

### New server behavior

- [x] start import jobs asynchronously
- [x] poll/relay extension status
- [x] allow clients to fetch assets individually
- [ ] optionally support SSE/WebSocket job progress later

## Bundle Storage Strategy

Choose one:

- [x] memory-backed only for early prototype
- [ ] disk-backed bundle staging for real usage

Recommended:

- [ ] disk-backed for asset bodies
- [ ] memory-backed for job metadata and manifest index

Reason:

- [ ] large sites will blow up process memory otherwise
- [ ] clients may need to fetch assets lazily after capture completes

## HTML Rewriting Strategy

Downstream faithful rendering usually needs rewritten references.

Implement:

- [ ] parse captured HTML
- [x] rewrite asset URLs that were captured into local `browsr` asset URLs
- [x] preserve unresolved URLs when the asset body was not captured
- [ ] record rewrite failures in manifest metadata

Optional future improvement:

- [ ] export a single self-contained HTML bundle when practical

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

Recommended extension/server error codes:

- [x] `IMPORT_BUNDLE_ATTACH_FAILED`
- [x] `IMPORT_BUNDLE_TIMEOUT`
- [x] `IMPORT_BUNDLE_CANCELLED`
- [x] `IMPORT_BUNDLE_RELOAD_FAILED`
- [ ] `IMPORT_BUNDLE_BODY_UNAVAILABLE`
- [ ] `IMPORT_BUNDLE_SIZE_LIMIT_EXCEEDED`
- [x] `HOST_PERMISSION_DENIED`
- [x] `UNSUPPORTED_TAB_URL`

## Validation Plan

### Extension validation

- [ ] verify debugger attach/detach for ordinary `https://` pages
- [ ] verify one import job per tab at a time
- [ ] verify sleeping/discarded tabs wake and reload correctly
- [ ] verify grouped tabs behave no differently than normal tabs
- [ ] verify capture completes for pages with many assets

### `browsr` validation

- [ ] verify import jobs survive long-running requests
- [ ] verify asset streaming works for binary bodies
- [ ] verify manifest is stable and reproducible
- [ ] verify snapshot endpoint remains fast and unaffected

### Manual tests

- [ ] import a simple static page with CSS and images
- [ ] import a large article page with many referenced assets
- [ ] import a tab from a restored session window
- [ ] import a grouped tab
- [ ] import a page with lazy-loaded images
- [ ] import a page with fonts and external stylesheets
- [ ] verify downstream client can render from bundle without origin requests

## Rollout Order

- [x] add debugger permission and attach lifecycle
- [x] add basic import job endpoint
- [x] record network events only
- [x] fetch asset bodies
- [x] capture final HTML
- [x] expose manifest endpoint
- [x] expose asset body endpoint
- [ ] add HTML URL rewriting
- [ ] add persistence and cleanup policies

## Recommendation

Build `import-bundle` as an explicit archival/import workflow, not as an extension of `snapshot`.

That means:

- [x] keep `snapshot` fast, cheap, and best-effort
- [x] keep `import-bundle` explicit, debugger-backed, reload-driven, and long-running
- [x] treat bundle capture as a job, not a single synchronous response

This separation will keep the system reliable and prevent the heavy import path from destabilizing the lightweight tab-inspection API.
