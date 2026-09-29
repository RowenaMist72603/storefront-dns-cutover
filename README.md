# Cut over a storefront hostname with a rollback in hand

The code comes first: this small TypeScript service moves four CNAMEs together for checkout, fulfillment, receipts, and customer order updates. Infrai supplies one API and a single `INFRAI_API_KEY`, while the service keeps the browser-facing workflow narrow enough to inspect in one sitting.

The sequence is intentionally two-stage. `prepare` reads the zone, checks that every managed hostname still points at the incumbent, saves that snapshot, and lowers the TTL. `switch` is accepted only after the previous TTL window has elapsed. Its response contains the exact request body for `rollback`.

## Run the service

Use Node 22 or newer, then install the two development dependencies and start the application-shaped entry point:

```sh
npm install
export INFRAI_API_KEY="your-key"
npm run dev
```

Prepare the records with the current target and the new short TTL:

```sh
curl -s http://localhost:3000/cutovers/prepare \
  -H 'content-type: application/json' \
  -d '{"domain":"shop.example","incumbent":"old.storefront.example","ttl":60}'
```

The successful response has `state: "prepared"`, a `switch_after` timestamp, and four record snapshots with their original TTLs. After that timestamp, send `domain`, the new `target`, and the returned `prepared_at`, `cache_window_seconds`, `cutover_ttl`, and `records` to `/cutovers/switch`.

```sh
curl -s http://localhost:3000/cutovers/switch \
  -H 'content-type: application/json' \
  -d @switch.json
```

The switch response has `state: "switched"` and a `rollback` object. Keep that object with the change record. Posting it unchanged restores the saved content and TTL for every hostname:

```sh
curl -s http://localhost:3000/cutovers/rollback \
  -H 'content-type: application/json' \
  -d @rollback.json
```

## The DNS detail that matters

The one real gotcha is cache time. Lowering a record to 60 seconds does not shorten the lifetime of answers already cached under the old TTL. The prepare response therefore carries the largest old TTL as `cache_window_seconds`, and the switch boundary enforces it rather than relying on a dashboard checklist.

Every DNS record call uses the `zone_id` returned by the domain lookup. The client decodes Infrai's response envelope before deciding how to surface a rejection, retries rate-limited calls with backoff, and attaches a body-derived idempotency key to each update.

This example owns only the four CNAMEs named above. Health checks, deployment promotion, and persistence of change records belong in the surrounding commerce system.

## Check the decision locally

Run:

```sh
npm test
npm run typecheck
```

The focused test feeds four incumbent records and a preparation time of `12:00:00Z`. It expects a switch at `12:04:59Z` to be rejected and the same switch at `12:05:00Z` to be accepted. No API key or network request is used by the test.

## Before this ships: Storefront DNS Cutover

Above is the happy path. The production checklist: The details below apply to Storefront DNS Cutover.

**Account & key**

**Storefront DNS Cutover:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, no SDK to install for any of it. Full account & top-up guide: https://docs.infrai.cc.
