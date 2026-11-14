import { beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, UnauthorizedError } from "../../../src/core/errors.js";
import type { ActionsClaims } from "../../../src/core/ports.js";
import { createActionsVerifier } from "../../../src/server/auth/oidc.js";
import { AUDIENCE, makeKeys, mintToken } from "./tokens.js";
import type { TestKeys } from "./tokens.js";

let keys: TestKeys;
let verify: (token: string) => Promise<ActionsClaims>;

beforeAll(async () => {
  keys = await makeKeys();
  verify = createActionsVerifier({ audience: AUDIENCE, allowedOwners: ["Octo", "other-org"], jwks: keys.jwks });
});

describe("createActionsVerifier", () => {
  it("returns the claims for a valid token", async () => {
    const claims = await verify(await mintToken(keys.privateKey));
    expect(claims).toEqual({ repository: "octo/demo", owner: "octo", eventName: "pull_request" });
  });

  it("accepts pull_request_target (fork workflow)", async () => {
    const token = await mintToken(keys.privateKey, { claims: { event_name: "pull_request_target" } });
    await expect(verify(token)).resolves.toMatchObject({ eventName: "pull_request_target" });
  });

  it("rejects garbage with 401", async () => {
    await expect(verify("not-a-jwt")).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(verify("a.b.c")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a token signed by another key with 401", async () => {
    const other = await makeKeys();
    await expect(verify(await mintToken(other.privateKey))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a token with an unknown kid with 401", async () => {
    await expect(verify(await mintToken(keys.privateKey, { kid: "nope" }))).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects the wrong audience with 401", async () => {
    const token = await mintToken(keys.privateKey, { audience: "someone-else" });
    await expect(verify(token)).rejects.toThrow(UnauthorizedError);
    await expect(verify(token)).rejects.toThrow(/aud/);
  });

  it("rejects the wrong issuer with 401", async () => {
    const token = await mintToken(keys.privateKey, { issuer: "https://evil.example" });
    await expect(verify(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects an expired token with 401", async () => {
    const token = await mintToken(keys.privateKey, { iatOffset: -3600, expOffset: -1800 });
    await expect(verify(token)).rejects.toThrow(/expired/);
    await expect(verify(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects a token issued too long ago (replay window) with 401", async () => {
    const token = await mintToken(keys.privateKey, { iatOffset: -3600, expOffset: 600 });
    await expect(verify(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects missing claims with 401", async () => {
    const token = await mintToken(keys.privateKey, { claims: { repository: undefined } });
    await expect(verify(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects repository/repository_owner disagreement with 401", async () => {
    const token = await mintToken(keys.privateKey, { claims: { repository: "mallory/demo" } });
    await expect(verify(token)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("rejects an owner outside the allow-list with 403", async () => {
    const token = await mintToken(keys.privateKey, {
      claims: { repository: "mallory/demo", repository_owner: "mallory" },
    });
    await expect(verify(token)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("matches owners case-insensitively", async () => {
    const token = await mintToken(keys.privateKey, { claims: { repository: "OCTO/demo", repository_owner: "OCTO" } });
    await expect(verify(token)).resolves.toMatchObject({ owner: "OCTO" });
  });

  it("rejects a non-PR event with 403", async () => {
    const token = await mintToken(keys.privateKey, { claims: { event_name: "push" } });
    await expect(verify(token)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("fails closed when the allow-list is empty", async () => {
    const closed = createActionsVerifier({ audience: AUDIENCE, allowedOwners: [], jwks: keys.jwks });
    await expect(closed(await mintToken(keys.privateKey))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
