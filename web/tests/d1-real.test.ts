// Runs only with a real D1 test database (CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, D1_API_TOKEN): the
// local stand-in imitates D1, this checks the imitation against the real thing (plan step 4e1, 4e4).
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { D1Client, D1Error, httpTransport } from "@/db/d1/client";

const env = { accountId: process.env.CLOUDFLARE_ACCOUNT_ID, databaseId: process.env.D1_DATABASE_ID, token: process.env.D1_API_TOKEN };
const configured = Boolean(env.accountId && env.databaseId && env.token);

describe.skipIf(!configured)("real D1", () => {
  const client = new D1Client(httpTransport({ accountId: env.accountId!, databaseId: env.databaseId!, token: env.token! }));
  const table = `zz_test_${randomBytes(4).toString("hex")}`;

  afterAll(async () => {
    if (configured) await client.batch([{ sql: `drop table if exists ${table}`, params: [] }]);
  });

  it("matches the stand-in on atomicity, refusals, value round-trips and errors", async () => {
    await client.batch([{ sql: `create table ${table} (id integer primary key, v text unique, n integer)`, params: [] }]);
    const failure = await client.batch([
      { sql: `insert into ${table} (id, v) values (1, 'a')`, params: [] },
      { sql: `insert into ${table} (id, v) values (2, 'a')`, params: [] },
    ]).catch((e) => e);
    expect(failure).toBeInstanceOf(D1Error);
    expect([failure.kind, failure.committed]).toEqual(["constraint", false]);
    expect((await client.batch([{ sql: `select count(*) from ${table}`, params: [] }]))[0].rows).toEqual([[0]]);

    const begin = await client.batch([{ sql: "BEGIN", params: [] }]).catch((e) => e);
    expect([begin.kind, begin.committed]).toEqual(["rejected", false]);

    await client.batch([{ sql: `insert into ${table} (id, v, n) values (?, ?, ?)`, params: [1, "😀\u2028\u0000", 9007199254740993n] }]);
    const [row] = (await client.batch([{ sql: `select v, cast(n as text), typeof(n) from ${table}`, params: [] }]))[0].rows;
    expect(row).toEqual(["😀\u2028\u0000", "9007199254740993", "integer"]);
    const unsafe = await client.batch([{ sql: `select n from ${table}`, params: [] }]).catch((e) => e);
    expect(unsafe.kind).toBe("unsafe_integer");
    expect(client.counters.requests).toBeGreaterThanOrEqual(5);
  });
});
