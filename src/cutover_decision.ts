import { z } from "zod";
import type { DnsRecord } from "./infrai_dns.ts";

export const managedNames = ["checkout", "fulfillment", "receipts", "orders"] as const;
export type ManagedName = (typeof managedNames)[number];

const endpointSchema = z.string().trim().min(1).refine(
  (value) => !value.startsWith("http://") && !value.startsWith("https://"),
  "Use a DNS target, not a URL",
);

export const prepareBodySchema = z.object({
  domain: z.string().trim().min(1),
  incumbent: endpointSchema,
  ttl: z.number().int().min(30).max(300).default(60),
}).strict();

const snapshotRecordSchema = z.object({
  record_id: z.string().min(1),
  record_type: z.literal("CNAME"),
  name: z.string().min(1),
  content: endpointSchema,
  ttl: z.number().int().positive(),
}).strict();

export const switchBodySchema = z.object({
  domain: z.string().trim().min(1),
  target: endpointSchema,
  prepared_at: z.string().datetime(),
  cache_window_seconds: z.number().int().positive(),
  cutover_ttl: z.number().int().min(30).max(300),
  records: z.array(snapshotRecordSchema).length(managedNames.length),
}).strict();

export const rollbackBodySchema = z.object({
  domain: z.string().trim().min(1),
  records: z.array(snapshotRecordSchema).length(managedNames.length),
}).strict();

export type ManagedRecord = z.infer<typeof snapshotRecordSchema>;

export function selectManagedRecords(
  domain: string,
  records: DnsRecord[],
  expectedContent?: string,
): ManagedRecord[] {
  const selected = managedNames.map((label) => {
    const fqdn = `${label}.${domain}`;
    const record = records.find((item) =>
      item.record_type === "CNAME" && (item.name === fqdn || item.name === label)
    );
    if (!record) throw new Error(`Missing managed CNAME: ${fqdn}`);
    if (expectedContent !== undefined && record.content !== expectedContent) {
      throw new Error(`${fqdn} does not point at the expected incumbent`);
    }
    return snapshotRecordSchema.parse(record);
  });
  return selected;
}

export function earliestSwitchAt(preparedAt: string, waitSeconds: number): Date {
  return new Date(new Date(preparedAt).getTime() + waitSeconds * 1000);
}

export function assertReadyToSwitch(preparedAt: string, waitSeconds: number, now: Date): void {
  const readyAt = earliestSwitchAt(preparedAt, waitSeconds);
  if (now < readyAt) throw new Error(`Cutover opens at ${readyAt.toISOString()}`);
}
