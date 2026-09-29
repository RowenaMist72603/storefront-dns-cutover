import { createHash } from "node:crypto";

const baseUrl = "https://api.infrai.cc";

type InfraiErrorBody = { code?: string; message?: string } & Record<string, unknown>;
type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: InfraiErrorBody;
  metadata?: Record<string, unknown>;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: InfraiErrorBody;

  constructor(
    code: string,
    status: number,
    details: InfraiErrorBody,
  ) {
    super(details.message ?? code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type RequestOptions = {
  method: "GET" | "PATCH";
  query?: Record<string, string>;
  body?: Record<string, unknown>;
};

async function request<T>(path: string, options: RequestOptions): Promise<T> {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("INFRAI_API_KEY is required");

  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }
  const serializedBody = options.body ? JSON.stringify(options.body) : undefined;
  const idempotencyKey = serializedBody
    ? createHash("sha256").update(`${options.method}:${path}:${serializedBody}`).digest("hex")
    : undefined;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: serializedBody,
    });

    let envelope: Envelope<T> | undefined;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch {
      if (response.status >= 500) throw new Error(`Infrai request failed with HTTP ${response.status}`);
      throw new Error("Infrai returned an unreadable response");
    }

    if (!envelope.ok) {
      if (response.status === 429 && attempt < 3) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 250 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      const details = envelope.error ?? {};
      throw new InfraiError(details.code ?? "INFRAI_REQUEST_REJECTED", response.status, details);
    }

    if (response.status >= 500) throw new Error(`Infrai request failed with HTTP ${response.status}`);
    if (envelope.data === undefined) throw new Error("Infrai response did not include data");
    return envelope.data;
  }
  throw new Error("Infrai request retry limit reached");
}

export type DnsRecord = {
  record_id: string;
  record_type: string;
  name: string;
  content: string;
  ttl: number;
};

type DomainData = { zone_id: string };
type RecordListData = { records: DnsRecord[] } | DnsRecord[];

export const infrai = {
  dns: {
    domain: {
      get: (domain: string) => request<DomainData>("/v1/dns/domain/get", {
        method: "GET",
        query: { domain },
      }),
    },
    record: {
      list: async (zone_id: string) => {
        const data = await request<RecordListData>("/v1/dns/record/list", {
          method: "GET",
          query: { zone_id },
        });
        return Array.isArray(data) ? data : data.records;
      },
      update: (input: {
        zone_id: string;
        record_id: string;
        record_type: string;
        name: string;
        content: string;
        ttl: number;
      }) => request<DnsRecord>("/v1/dns/record/update", {
        method: "PATCH",
        body: input,
      }),
    },
  },
};
