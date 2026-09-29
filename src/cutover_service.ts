import { createServer, type ServerResponse } from "node:http";
import { z, ZodError, type ZodTypeAny } from "zod";
import {
  assertReadyToSwitch,
  prepareBodySchema,
  rollbackBodySchema,
  selectManagedRecords,
  switchBodySchema,
  type ManagedRecord,
} from "./cutover_decision.ts";
import { infrai, InfraiError } from "./infrai_dns.ts";

const maxBodyBytes = 64 * 1024;

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readBody<T extends ZodTypeAny>(
  request: AsyncIterable<Uint8Array>,
  schema: T,
): Promise<z.output<T>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

async function updateRecords(
  zone_id: string,
  records: ManagedRecord[],
  content: (record: ManagedRecord) => string,
  ttl: (record: ManagedRecord) => number,
): Promise<void> {
  await Promise.all(records.map((record) => infrai.dns.record.update({
    zone_id,
    record_id: record.record_id,
    record_type: record.record_type,
    name: record.name,
    content: content(record),
    ttl: ttl(record),
  })));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/cutovers/prepare") {
      const body = await readBody(request, prepareBodySchema);
      const { zone_id } = await infrai.dns.domain.get(body.domain);
      const records = selectManagedRecords(
        body.domain,
        await infrai.dns.record.list(zone_id),
        body.incumbent,
      );
      const cache_window_seconds = Math.max(...records.map((record) => record.ttl));
      await updateRecords(zone_id, records, (record) => record.content, () => body.ttl);
      const prepared_at = new Date().toISOString();
      send(response, 200, {
        state: "prepared",
        prepared_at,
        cache_window_seconds,
        cutover_ttl: body.ttl,
        switch_after: new Date(Date.parse(prepared_at) + cache_window_seconds * 1000).toISOString(),
        records,
      });
      return;
    }

    if (request.method === "POST" && request.url === "/cutovers/switch") {
      const body = await readBody(request, switchBodySchema);
      assertReadyToSwitch(body.prepared_at, body.cache_window_seconds, new Date());
      const { zone_id } = await infrai.dns.domain.get(body.domain);
      await updateRecords(zone_id, body.records, () => body.target, () => body.cutover_ttl);
      send(response, 200, {
        state: "switched",
        target: body.target,
        rollback: { domain: body.domain, records: body.records },
      });
      return;
    }

    if (request.method === "POST" && request.url === "/cutovers/rollback") {
      const body = await readBody(request, rollbackBodySchema);
      const { zone_id } = await infrai.dns.domain.get(body.domain);
      await updateRecords(zone_id, body.records, (record) => record.content, (record) => record.ttl);
      send(response, 200, { state: "rolled_back", restored: body.records.map((record) => record.name) });
      return;
    }

    send(response, 404, { error: "Route not found" });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      send(response, 400, { error: "Invalid request body" });
      return;
    }
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      send(response, status, { error: error.message, code: error.code });
      return;
    }
    send(response, 409, { error: error instanceof Error ? error.message : "Cutover rejected" });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  console.log(`DNS cutover service listening on http://localhost:${port}`);
});
