import { randomUUID } from "node:crypto";
import type { Env } from "@idx/config";
import type { Db } from "@idx/db";
import { schema } from "@idx/db";
import type { ZodIssue } from "zod";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/**
 * Raw payload archive (blueprint: "Raw archive: Object storage / Replay and
 * audit input payloads"). Postgres `raw_payload_archive.payload jsonb` is
 * the source of truth for replay; S3-compatible object storage is a
 * secondary durability layer. An S3 failure is logged and swallowed — it
 * must never block the adapter call or lose the Postgres row.
 */

export interface ArchiveEntry {
  endpoint: string;
  symbol: string | null;
  requestedAt: string;
  receivedAt: string;
  httpStatus: number;
  payload: unknown;
  schemaValid: boolean;
  schemaErrors: ZodIssue[] | null;
}

let s3Client: S3Client | null = null;

function getS3Client(env: Env): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: env.OBJECT_STORAGE_ENDPOINT,
      region: env.OBJECT_STORAGE_REGION,
      forcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY,
        secretAccessKey: env.OBJECT_STORAGE_SECRET_KEY
      }
    });
  }
  return s3Client;
}

/** Reset the cached S3 client (tests only, or after credential rotation). */
export function resetS3ClientForTests(): void {
  s3Client = null;
}

export async function archiveRawPayload(
  db: Db,
  env: Env,
  entry: ArchiveEntry,
  opts: { skipS3?: boolean | undefined } = {}
): Promise<string> {
  const id = randomUUID();

  await db.insert(schema.rawPayloadArchive).values({
    id,
    endpoint: entry.endpoint,
    symbol: entry.symbol,
    requestedAt: new Date(entry.requestedAt),
    receivedAt: new Date(entry.receivedAt),
    httpStatus: entry.httpStatus,
    payload: entry.payload as object,
    schemaValid: entry.schemaValid,
    schemaErrors: entry.schemaErrors as object | null
  });

  if (!opts.skipS3) {
    try {
      const client = getS3Client(env);
      const key = `${entry.endpoint.replace(/^\/+/, "")}/${entry.symbol ?? "_"}/${id}.json`;
      await client.send(
        new PutObjectCommand({
          Bucket: env.OBJECT_STORAGE_BUCKET,
          Key: key,
          Body: JSON.stringify({ ...entry }),
          ContentType: "application/json"
        })
      );
    } catch (err) {
      // Secondary durability layer only — never let an S3 outage block the
      // adapter or drop the Postgres audit row, which is already committed.
      console.error(`[archive] S3 archive write failed for ${entry.endpoint} (id=${id}):`, err);
    }
  }

  return id;
}
