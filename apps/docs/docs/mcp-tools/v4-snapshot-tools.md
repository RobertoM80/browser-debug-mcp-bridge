# V4 Snapshot Tools

These tools expose persisted snapshot metadata and bounded PNG asset reads for downstream analysis.

## list_snapshots

Find snapshots for a session with optional trigger/time filters.

- Inputs: `sessionId`, optional `trigger`, `sinceTimestamp`, `untilTimestamp`, `limit`, `offset`
- Output: metadata only (`snapshotId`, timestamp, trigger, mode, truncation flags, `hasPng`, `pngBytes`)
- Limits: standard pagination with `maxResults` and `truncated`

## get_snapshot_for_event

Resolve the best snapshot for an anchor event.

- Inputs: `sessionId`, `eventId`, optional `maxDeltaMs`
- Match order:
  1. Exact `trigger_event_id`
  2. Nearest snapshot timestamp after the event within `maxDeltaMs`
- Output: `matchReason` (`trigger_event_id`, `nearest_timestamp`, `none`) and snapshot metadata

## get_snapshot_asset

Read PNG assets with strict chunking bounds.

- Inputs: `sessionId`, `snapshotId`, optional `offset`, `maxBytes`, `encoding` (`raw` or `base64`)
- Output: chunk payload plus `hasMore` and `nextOffset` for continuation
- Limits:
  - `maxBytes` is bounded to avoid oversized MCP payloads
  - Asset reads are explicit (separate from metadata tools)

## Contract boundaries

- Ingestion path: extension/server HTTP + WebSocket writes snapshots.
- MCP path: read-only queries for metadata and binary chunks.
