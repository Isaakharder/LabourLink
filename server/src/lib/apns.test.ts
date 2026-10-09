import http2 from "http2";
import { AddressInfo } from "net";
import { generateKeyPairSync, verify } from "crypto";
import {
  ApnsClient,
  ApnsEnvironment,
  buildProviderToken,
  isPermanentApnsTokenFailure,
  loadApnsConfig,
  sendWithEnvironmentFallback,
} from "./apns";

// No network, no database: two local cleartext HTTP/2 servers stand in for
// APNs production and sandbox, and a throwaway P-256 key stands in for the
// .p8 signing key.

let pass = 0;
let fail = 0;
function check(condition: boolean, label: string, extra?: unknown) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}`, extra !== undefined ? JSON.stringify(extra) : "");
  }
}

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function decodeJwt(token: string) {
  const [h, c, s] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    claims: JSON.parse(Buffer.from(c, "base64url").toString()),
    validSignature: verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")),
  };
}

interface Seen {
  environment: ApnsEnvironment;
  path: string;
  headers: http2.IncomingHttpHeaders;
  body: string;
}

// Per-token behaviour of the fake gateways.
function respond(environment: ApnsEnvironment, token: string): { status: number; reason?: string } {
  if (token === "aa11") return { status: 200 };
  if (token === "bb22") return environment === "sandbox" ? { status: 200 } : { status: 400, reason: "BadDeviceToken" };
  if (token === "cc33") return { status: 410, reason: "Unregistered" };
  if (token === "dd44") return { status: 400, reason: "BadDeviceToken" };
  if (token === "ee55") return { status: 403, reason: "InvalidProviderToken" };
  return { status: 500, reason: "InternalServerError" };
}

function startGateway(environment: ApnsEnvironment, seen: Seen[]): Promise<http2.Http2Server> {
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (c: string) => (body += c));
    stream.on("end", () => {
      const path = String(headers[":path"]);
      seen.push({ environment, path, headers, body });
      const { status, reason } = respond(environment, path.replace("/3/device/", ""));
      stream.respond({ ":status": status, "content-type": "application/json" });
      stream.end(reason ? JSON.stringify({ reason }) : "");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  // --- config loading ---
  check(loadApnsConfig({}) === null, "missing env -> null (iOS push disabled, server still starts)");
  const escaped = pem.replace(/\n/g, "\\n");
  const config = loadApnsConfig({ APNS_KEY_ID: "KEY1234567", APNS_TEAM_ID: "TEAM123456", APNS_PRIVATE_KEY: escaped });
  check(config !== null, "single-line (\\n-escaped) .p8 is accepted");
  check(config?.bundleId === "com.linklogictechnologies.labourlink", "bundle ID defaults to LabourLink", config?.bundleId);
  if (!config) throw new Error("config failed to load");

  // --- provider token ---
  const jwt = decodeJwt(buildProviderToken(config, 1_700_000_000));
  check(jwt.header.alg === "ES256" && jwt.header.kid === "KEY1234567", "JWT header has ES256 + key ID", jwt.header);
  check(jwt.claims.iss === "TEAM123456" && jwt.claims.iat === 1_700_000_000, "JWT claims carry team ID + iat", jwt.claims);
  check(jwt.validSignature, "JWT signature verifies with the matching public key");

  // --- sending ---
  const seen: Seen[] = [];
  const prod = await startGateway("production", seen);
  const sandbox = await startGateway("sandbox", seen);
  const hosts = {
    production: `http://127.0.0.1:${(prod.address() as AddressInfo).port}`,
    sandbox: `http://127.0.0.1:${(sandbox.address() as AddressInfo).port}`,
  };
  let now = 1_700_000_000_000;
  const client = new ApnsClient(config, hosts, () => now);
  const payload = { aps: { alert: { title: "LabourLink", body: "You have a new message." }, sound: "default" }, type: "message" };

  const ok = await sendWithEnvironmentFallback(client, "aa11", null, payload);
  check(ok.result.ok && ok.environment === "production", "unknown environment tries production first", ok);
  const req = seen[0];
  check(req.path === "/3/device/aa11", "posts to /3/device/<token>", req.path);
  check(req.headers["apns-topic"] === "com.linklogictechnologies.labourlink", "apns-topic is the bundle ID", req.headers["apns-topic"]);
  check(req.headers["apns-push-type"] === "alert" && req.headers["apns-priority"] === "10", "alert push type, priority 10");
  check(JSON.parse(req.body).aps.alert.title === "LabourLink", "payload is sent as JSON", req.body);
  const auth = String(req.headers.authorization);
  check(auth.startsWith("bearer ") && decodeJwt(auth.slice(7)).validSignature, "authorization is a valid bearer JWT");

  const sandboxOnly = await sendWithEnvironmentFallback(client, "bb22", null, payload);
  check(sandboxOnly.result.ok && sandboxOnly.environment === "sandbox", "BadDeviceToken on production falls back to sandbox", sandboxOnly);

  const remembered = seen.length;
  const direct = await sendWithEnvironmentFallback(client, "bb22", "sandbox", payload);
  check(direct.result.ok && seen.length === remembered + 1, "a remembered sandbox token goes straight to sandbox", direct);

  const gone = await sendWithEnvironmentFallback(client, "cc33", "production", payload);
  check(!gone.result.ok && isPermanentApnsTokenFailure(gone.result), "410 Unregistered is permanent", gone);

  const badBoth = await sendWithEnvironmentFallback(client, "dd44", null, payload);
  check(!badBoth.result.ok && isPermanentApnsTokenFailure(badBoth.result), "BadDeviceToken on both gateways is permanent", badBoth);

  const providerErr = await sendWithEnvironmentFallback(client, "ee55", "production", payload);
  check(!providerErr.result.ok && !isPermanentApnsTokenFailure(providerErr.result), "InvalidProviderToken never disables the device", providerErr);

  const serverErr = await sendWithEnvironmentFallback(client, "ff66", "production", payload);
  check(!serverErr.result.ok && !isPermanentApnsTokenFailure(serverErr.result), "5xx never disables the device", serverErr);

  // --- token caching ---
  seen.length = 0;
  await client.send("production", "aa11", payload);
  await client.send("production", "aa11", payload);
  check(seen[0].headers.authorization === seen[1].headers.authorization, "provider token is reused within its window");
  now += 41 * 60 * 1000;
  await client.send("production", "aa11", payload);
  check(seen[2].headers.authorization !== seen[1].headers.authorization, "provider token is refreshed after 40 minutes");

  client.close();
  prod.close();
  sandbox.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
