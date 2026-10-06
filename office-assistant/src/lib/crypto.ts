import crypto from "node:crypto";
import { config } from "../config";

// AES-256-GCM. Stored as base64(iv[12] | tag[16] | ciphertext).

function key(raw = config.encryptionKey()): Buffer {
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be 32 bytes, base64 encoded");
  return k;
}

export function encryptJson(value: unknown, rawKey?: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(rawKey), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptJson<T>(blob: string, rawKey?: string): T {
  const buf = Buffer.from(blob, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(rawKey), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const pt = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}
