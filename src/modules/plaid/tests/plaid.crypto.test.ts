import { expect, it } from "vitest";
import { createTokenCipher } from "../plaid.crypto.js";

it("round-trips the legacy secretbox base64 token format", () => {
  const cipher = createTokenCipher("a".repeat(64));
  const encrypted = cipher.encrypt("access-sandbox-secret");

  expect(encrypted.encrypted).not.toContain("access-sandbox-secret");
  expect(cipher.decrypt(encrypted)).toBe("access-sandbox-secret");
});

it("rejects malformed keys and ciphertext", () => {
  expect(() => createTokenCipher("short")).toThrow("64 hexadecimal");
  const cipher = createTokenCipher("b".repeat(64));
  expect(() => cipher.decrypt({ encrypted: "bad", nonce: "bad" })).toThrow(
    "decrypt",
  );
});
