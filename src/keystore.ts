import { getStore } from "@netlify/blobs";

const MAX_TTL_MS = 60 * 60 * 1000;
const STORE = "amber-key";
const KEY = "current";

interface Stored {
  iv: string;
  ct: string;
  expiresAt: number;
}

const b64 = (buf: ArrayBuffer | Uint8Array) =>
  Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

async function cryptoKey(): Promise<CryptoKey> {
  const secret = process.env.KEY_ENCRYPTION_SECRET;
  if (!secret) throw new Error("KEY_ENCRYPTION_SECRET is not configured");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}

const store = () => getStore({ name: STORE, consistency: "strong" });

export async function setKey(apiKey: string, ttlMinutes = 60): Promise<number> {
  const ttl = Math.min(Math.max(ttlMinutes, 1) * 60_000, MAX_TTL_MS);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await cryptoKey(),
    new TextEncoder().encode(apiKey),
  );
  const expiresAt = Date.now() + ttl;
  const record: Stored = { iv: b64(iv), ct: b64(ct), expiresAt };
  await store().setJSON(KEY, record);
  return expiresAt;
}

export async function getKey(): Promise<string | null> {
  const s = store();
  const rec = (await s.get(KEY, { type: "json" })) as Stored | null;
  if (!rec) return null;
  if (Date.now() >= rec.expiresAt || rec.expiresAt - Date.now() > MAX_TTL_MS) {
    await s.delete(KEY);
    return null;
  }
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(rec.iv) },
    await cryptoKey(),
    unb64(rec.ct),
  );
  return new TextDecoder().decode(pt);
}

export async function keyStatus(): Promise<{ set: boolean; expiresAt?: number; minutesRemaining?: number }> {
  const s = store();
  const rec = (await s.get(KEY, { type: "json" })) as Stored | null;
  if (!rec || Date.now() >= rec.expiresAt) {
    if (rec) await s.delete(KEY);
    return { set: false };
  }
  return { set: true, expiresAt: rec.expiresAt, minutesRemaining: Math.ceil((rec.expiresAt - Date.now()) / 60_000) };
}

export async function clearKey(): Promise<void> {
  await store().delete(KEY);
}
