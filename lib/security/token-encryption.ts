import "server-only";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = Uint8Array.from(value);
  return copy.buffer;
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptProviderToken(token: string): Promise<string> {
  const secret = process.env.PROVIDER_TOKEN_ENCRYPTION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "PROVIDER_TOKEN_ENCRYPTION_SECRET must contain at least 32 characters.",
    );
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    encoder.encode(token),
  );
  return `${toBase64(iv)}.${toBase64(new Uint8Array(encrypted))}`;
}

export async function decryptProviderToken(payload: string): Promise<string> {
  const secret = process.env.PROVIDER_TOKEN_ENCRYPTION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Token encryption is not configured.");
  }
  const [ivPart, encryptedPart] = payload.split(".");
  if (!ivPart || !encryptedPart) throw new Error("Encrypted token is invalid.");
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(fromBase64(ivPart)) },
    await encryptionKey(secret),
    asArrayBuffer(fromBase64(encryptedPart)),
  );
  return decoder.decode(decrypted);
}
