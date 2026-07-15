import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function encryptionKey(secret) {
  return createHash("sha256").update(String(secret)).digest();
}

export function encryptSecret(value, secret) {
  const plainText = String(value ?? "");
  if (!plainText) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret(value, secret) {
  if (!value) return "";
  const [version, ivPart, tagPart, encryptedPart] = String(value).split(".");
  if (version !== "v1" || !ivPart || !tagPart || !encryptedPart) throw new Error("Das gespeicherte Mail-Passwort kann nicht entschlüsselt werden.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(secret), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedPart, "base64url")), decipher.final()]).toString("utf8");
}
