/** Small Web Crypto helpers shared by the bank Worker. Runs in Workers and Node 20+. */

const te = new TextEncoder();
const td = new TextDecoder();

export const b64url = (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const b64urlToBytes = (s) => {
  const str = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(str + "===".slice((str.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function sha256Hex(input) {
  const data = typeof input === "string" ? te.encode(input) : input;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Constant-time compare of two strings by hashing both first. */
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256Hex(String(a ?? "")), sha256Hex(String(b ?? ""))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0 && a != null && b != null && String(a).length > 0;
}

async function tokenKey(secret) {
  const raw = b64urlToBytes(secret);
  if (raw.length !== 32) throw new Error("TOKEN_ENC_KEY must be 32 bytes, base64url");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypt a Plaid access token at rest. The item id is bound as additional data. */
export async function sealToken(secret, itemId, plain) {
  const key = await tokenKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(itemId) }, key, te.encode(plain)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return "v1." + b64url(out);
}

export async function openToken(secret, itemId, sealed) {
  if (!String(sealed || "").startsWith("v1.")) throw new Error("bad sealed token");
  const key = await tokenKey(secret);
  const buf = b64urlToBytes(sealed.slice(3));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12), additionalData: te.encode(itemId) }, key, buf.slice(12));
  return td.decode(pt);
}

export const HKDF_INFO = "toozbudgeting-bank-v1";

/** Check that a JWK is a usable P-256 ECDH public key. Returns the trimmed JWK. */
export async function checkDeviceKey(jwk) {
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || jwk.d) throw new Error("publicKey must be a P-256 public JWK");
  const pub = { kty: "EC", crv: "P-256", x: String(jwk.x), y: String(jwk.y) };
  await crypto.subtle.importKey("jwk", pub, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return pub;
}

async function aesFromShared(sharedBits, salt) {
  const ikm = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: te.encode(HKDF_INFO) },
    ikm, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt a JSON value to a device's P-256 public key (ECIES: ephemeral ECDH, HKDF-SHA256, AES-256-GCM).
 * Only the device, which holds the private key, can read it.
 */
export async function sealForDevice(deviceJwk, value) {
  const devKey = await crypto.subtle.importKey("jwk", deviceJwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: devKey }, eph.privateKey, 256);
  const epkRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const key = await aesFromShared(shared, epkRaw);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(value))));
  return JSON.stringify({ v: 1, epk: b64url(epkRaw), iv: b64url(iv), ct: b64url(ct) });
}

/** The device side of sealForDevice. Kept here so tests can round-trip; the app has its own copy. */
export async function openForDevice(privateKey, sealed) {
  const o = typeof sealed === "string" ? JSON.parse(sealed) : sealed;
  const epkRaw = b64urlToBytes(o.epk);
  const epk = await crypto.subtle.importKey("raw", epkRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: epk }, privateKey, 256);
  const key = await aesFromShared(shared, epkRaw);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlToBytes(o.iv) }, key, b64urlToBytes(o.ct));
  return JSON.parse(td.decode(pt));
}

/** Verify a compact ES256 JWT with a P-256 JWK. Returns the payload or throws. */
export async function verifyEs256(jwt, jwk) {
  const parts = String(jwt || "").split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  const header = JSON.parse(td.decode(b64urlToBytes(parts[0])));
  if (header.alg !== "ES256") throw new Error("unexpected JWT alg");
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64urlToBytes(parts[2]), te.encode(parts[0] + "." + parts[1]));
  if (!ok) throw new Error("bad JWT signature");
  return JSON.parse(td.decode(b64urlToBytes(parts[1])));
}

export function jwtHeader(jwt) {
  const first = String(jwt || "").split(".")[0];
  return JSON.parse(td.decode(b64urlToBytes(first)));
}
