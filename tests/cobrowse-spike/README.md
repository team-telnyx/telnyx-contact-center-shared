# Web co-browsing F0 spike

This isolated harness validates the riskiest assumptions in the proposed web
co-browsing architecture without enabling any production path.

It bundles the pinned rrweb recorder and replayer, starts an in-memory WebSocket
relay, and drives a mobile-sized Chromium page with 4x CPU throttling. The run
checks privacy masking, hostile replay isolation, shadow DOM and iframe behavior,
SPA mutation delivery, sequence-gap resynchronization, reconnects with fresh
single-use tickets, and snapshot/steady-state payload sizes.

Run it with:

```bash
yarn test:cobrowse:spike
```

The command prints a JSON evidence object and exits non-zero when a safety or
correctness check fails. It does not contact Telnyx services or persist captured
DOM payloads.
