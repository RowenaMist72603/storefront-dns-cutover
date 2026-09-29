import assert from "node:assert/strict";
import test from "node:test";
import { assertReadyToSwitch, selectManagedRecords } from "../src/cutover_decision.ts";
import type { DnsRecord } from "../src/infrai_dns.ts";

const domain = "shop.example";
const records: DnsRecord[] = ["checkout", "fulfillment", "receipts", "orders"].map((name) => ({
  record_id: `rec-${name}`,
  record_type: "CNAME",
  name: `${name}.${domain}`,
  content: "old.storefront.example",
  ttl: 300,
}));

test("the switch waits out the incumbent TTL for all four commerce records", () => {
  const selected = selectManagedRecords(domain, records, "old.storefront.example");
  assert.equal(selected.length, 4);
  assert.throws(
    () => assertReadyToSwitch("2026-06-01T12:00:00.000Z", 300, new Date("2026-06-01T12:04:59.000Z")),
    /Cutover opens at 2026-06-01T12:05:00.000Z/,
  );
  assert.doesNotThrow(
    () => assertReadyToSwitch("2026-06-01T12:00:00.000Z", 300, new Date("2026-06-01T12:05:00.000Z")),
  );
});
