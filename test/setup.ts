/**
 * Rule zero (acr-testing): tests never reach the network except localhost
 * (integration tests use local Redis/Postgres over TCP, which this does not block).
 */
delete process.env.ANTHROPIC_API_KEY;
process.env.NODE_ENV = "test";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error(`Network access blocked in tests: ${url.href}. Use a fake (test/fakes).`);
  }
  return realFetch(input, init);
}) as typeof fetch;
