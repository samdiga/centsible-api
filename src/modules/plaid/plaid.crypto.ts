import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";
import { loadEnv } from "../../platform/config/env.js";

export type EncryptedToken = Readonly<{
  encrypted: string;
  nonce: string;
}>;

export type TokenCipher = Readonly<{
  encrypt: (plaintext: string) => EncryptedToken;
  decrypt: (token: EncryptedToken) => string;
}>;

/** Uses the legacy TweetNaCl secretbox/base64 representation stored in Neon. */
export function createTokenCipher(hexKey: string): TokenCipher {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey))
    throw new Error("Plaid token key must contain 64 hexadecimal characters");
  const key = Uint8Array.from(Buffer.from(hexKey, "hex"));
  return {
    encrypt(plaintext) {
      const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
      const ciphertext = nacl.secretbox(
        naclUtil.decodeUTF8(plaintext),
        nonce,
        key,
      );
      return {
        encrypted: naclUtil.encodeBase64(ciphertext),
        nonce: naclUtil.encodeBase64(nonce),
      };
    },
    decrypt(token) {
      try {
        const plaintext = nacl.secretbox.open(
          naclUtil.decodeBase64(token.encrypted),
          naclUtil.decodeBase64(token.nonce),
          key,
        );
        if (!plaintext) throw new Error("invalid ciphertext");
        return naclUtil.encodeUTF8(plaintext);
      } catch {
        throw new Error("failed to decrypt access token");
      }
    },
  };
}

function runtimeCipher(): TokenCipher {
  const key = loadEnv().PLAID_TOKEN_KEY;
  if (!key) throw new Error("PLAID_TOKEN_KEY is required");
  return createTokenCipher(key);
}

export const encryptToken = (plaintext: string): EncryptedToken =>
  runtimeCipher().encrypt(plaintext);
export const decryptToken = (token: EncryptedToken): string =>
  runtimeCipher().decrypt(token);
