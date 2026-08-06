import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  compareVersions,
  computeDrift,
  driftResourceName,
  hostLabel,
  instanceResourceName,
  model,
  normaliseTag,
  parseVersion,
} from "./openwebui_instance.ts";

/* ------------------------------------------------------------------ *
 * Version parsing
 * ------------------------------------------------------------------ */

Deno.test("parseVersion strips the leading v that GitHub tags carry", () => {
  assertEquals(parseVersion("v0.11.0"), {
    major: 0,
    minor: 11,
    patch: 0,
    prerelease: null,
  });
  // The instance reports the same version without the prefix; both must land
  // on the same parse or every comparison crosses a mismatch.
  assertEquals(parseVersion("0.11.0"), parseVersion("v0.11.0"));
});

Deno.test("parseVersion fills in missing minor and patch", () => {
  assertEquals(parseVersion("1"), {
    major: 1,
    minor: 0,
    patch: 0,
    prerelease: null,
  });
  assertEquals(parseVersion("1.2"), {
    major: 1,
    minor: 2,
    patch: 0,
    prerelease: null,
  });
});

Deno.test("parseVersion separates prerelease and drops build metadata", () => {
  assertEquals(parseVersion("0.11.0-rc1"), {
    major: 0,
    minor: 11,
    patch: 0,
    prerelease: "rc1",
  });
  // Build metadata never participates in precedence.
  assertEquals(parseVersion("0.11.0+abc123"), {
    major: 0,
    minor: 11,
    patch: 0,
    prerelease: null,
  });
});

Deno.test("parseVersion rejects things that are not versions", () => {
  assertEquals(parseVersion(""), null);
  assertEquals(parseVersion("   "), null);
  assertEquals(parseVersion("main"), null);
  assertEquals(parseVersion("9bd84258d09eefe7bf975878fb0e31a5dadfe0f8"), null);
  assertEquals(parseVersion("1.2.3.4"), null);
  assertEquals(parseVersion("1.x.3"), null);
});

/* ------------------------------------------------------------------ *
 * Comparison — the two traps that motivated numeric parsing
 * ------------------------------------------------------------------ */

Deno.test("compareVersions: 0.8.12 is OLDER than 0.11.0", () => {
  // As strings, "0.8.12" > "0.11.0" — the exact inversion that would have
  // reported an instance eleven releases behind as up to date.
  const older = parseVersion("0.8.12")!;
  const newer = parseVersion("0.11.0")!;
  assertEquals(compareVersions(older, newer) < 0, true);
  assertEquals(compareVersions(newer, older) > 0, true);
});

Deno.test("compareVersions: 0.8.9 is OLDER than 0.8.12", () => {
  // The same inversion one component down: "0.8.12" < "0.8.9" as strings.
  const older = parseVersion("0.8.9")!;
  const newer = parseVersion("0.8.12")!;
  assertEquals(compareVersions(older, newer) < 0, true);
});

Deno.test("compareVersions: equal versions compare equal", () => {
  assertEquals(compareVersions(parseVersion("0.8.12")!, parseVersion("v0.8.12")!), 0);
});

Deno.test("compareVersions: a prerelease sorts below its final release", () => {
  const rc = parseVersion("0.11.0-rc1")!;
  const final = parseVersion("0.11.0")!;
  assertEquals(compareVersions(rc, final) < 0, true);
  assertEquals(compareVersions(parseVersion("0.11.0-rc1")!, parseVersion("0.11.0-rc2")!) < 0, true);
});

Deno.test("normaliseTag reports versions the way the instance does", () => {
  assertEquals(normaliseTag("v0.11.0"), "0.11.0");
  assertEquals(normaliseTag("0.11.0"), "0.11.0");
});

/* ------------------------------------------------------------------ *
 * Drift, against the real upstream release list
 * ------------------------------------------------------------------ */

// The actual tags from open-webui/open-webui, newest first, as of 2026-08-06.
const REAL_RELEASES = [
  { tag: "v0.11.0", publishedAt: "2026-07-27T09:30:15Z" },
  { tag: "v0.10.2", publishedAt: "2026-07-01T08:41:06Z" },
  { tag: "v0.10.1", publishedAt: "2026-06-29T19:38:44Z" },
  { tag: "v0.10.0", publishedAt: "2026-06-29T19:17:48Z" },
  { tag: "v0.9.6", publishedAt: "2026-06-01T21:57:03Z" },
  { tag: "v0.9.5", publishedAt: "2026-05-10T18:14:07Z" },
  { tag: "v0.9.4", publishedAt: "2026-05-09T07:50:17Z" },
  { tag: "v0.9.3", publishedAt: "2026-05-09T07:17:19Z" },
  { tag: "v0.9.2", publishedAt: "2026-04-24T09:56:14Z" },
  { tag: "v0.9.1", publishedAt: "2026-04-21T10:45:37Z" },
  { tag: "v0.9.0", publishedAt: "2026-04-21T07:56:15Z" },
  { tag: "v0.8.12", publishedAt: "2026-03-27T00:26:52Z" },
  { tag: "v0.8.11", publishedAt: "2026-03-20T00:00:00Z" },
];

Deno.test("computeDrift: an instance on 0.8.12 is eleven releases behind", () => {
  const d = computeDrift("0.8.12", REAL_RELEASES);
  assertEquals(d.status, "behind");
  assertEquals(d.behind, true);
  assertEquals(d.releasesBehind, 11);
  assertEquals(d.latestVersion, "0.11.0");
  assertEquals(d.latestPublishedAt, "2026-07-27T09:30:15Z");
  // Newest first, and the running version itself is not "missed".
  assertEquals(d.missedReleases[0], "v0.11.0");
  assertEquals(d.missedReleases.includes("v0.8.12"), false);
  assertEquals(d.missedReleases.includes("v0.8.11"), false);
});

Deno.test("computeDrift: running the newest release is current", () => {
  const d = computeDrift("0.11.0", REAL_RELEASES);
  assertEquals(d.status, "current");
  assertEquals(d.behind, false);
  assertEquals(d.releasesBehind, 0);
  assertEquals(d.missedReleases, []);
});

Deno.test("computeDrift: a build newer than any release reports ahead, not behind", () => {
  // What a :main build looks like once upstream has moved past its last tag.
  const d = computeDrift("0.12.0", REAL_RELEASES);
  assertEquals(d.status, "ahead");
  assertEquals(d.behind, false);
  assertEquals(d.releasesBehind, 0);
});

Deno.test("computeDrift: release order in the input does not matter", () => {
  const shuffled = [...REAL_RELEASES].reverse();
  const d = computeDrift("0.8.12", shuffled);
  assertEquals(d.latestVersion, "0.11.0");
  assertEquals(d.releasesBehind, 11);
});

Deno.test("computeDrift: an unparseable running version throws rather than guessing", () => {
  // Reporting "current" because the comparison could not be made is the exact
  // failure this model exists to prevent.
  assertThrows(
    () => computeDrift("main", REAL_RELEASES),
    Error,
    "Cannot parse running version",
  );
});

Deno.test("computeDrift: no parseable releases throws rather than reporting current", () => {
  assertThrows(
    () => computeDrift("0.8.12", [{ tag: "nightly", publishedAt: null }]),
    Error,
    "No parseable releases",
  );
});

Deno.test("computeDrift: unparseable tags are skipped, not fatal, when others parse", () => {
  const d = computeDrift("0.8.12", [
    { tag: "nightly", publishedAt: null },
    ...REAL_RELEASES,
  ]);
  assertEquals(d.latestVersion, "0.11.0");
  assertEquals(d.missedReleases.includes("nightly"), false);
});

/* ------------------------------------------------------------------ *
 * Resource naming
 *
 * writeResource instance names share ONE flat namespace across specs, so
 * a collision silently overwrites data on disk with nothing failing at
 * validation or in a mocked test. Hence an explicit regression test.
 * ------------------------------------------------------------------ */

Deno.test("hostLabel keeps host and port, and stays path-safe", () => {
  assertEquals(hostLabel("http://localhost:3000"), "localhost-3000");
  assertEquals(hostLabel("https://openwebui.example.com"), "openwebui.example.com");
  assertEquals(hostLabel("http://192.0.2.10:3000"), "192.0.2.10-3000");
  assertEquals(/^[A-Za-z0-9._-]+$/.test(hostLabel("http://a b/c")), true);
});

Deno.test("instance and drift resource names can never collide", () => {
  const urls = [
    "http://localhost:3000",
    "https://openwebui.example.com",
    "http://192.0.2.10:3000",
    "http://instance-localhost",
    "http://drift-localhost",
  ];
  const seen = new Set<string>();
  for (const u of urls) {
    for (const name of [instanceResourceName(u), driftResourceName(u)]) {
      assertEquals(seen.has(name), false, `duplicate resource name: ${name}`);
      seen.add(name);
    }
  }
  assertEquals(seen.size, urls.length * 2);
});

Deno.test("different instances get different resource names", () => {
  assertEquals(
    instanceResourceName("http://localhost:3000") ===
      instanceResourceName("http://localhost:3001"),
    false,
  );
});

/* ------------------------------------------------------------------ *
 * execute(), with a schema-validating writeResource
 *
 * A recording-only stub would accept any shape and make every schema bug
 * invisible, so this one parses against the model's declared schema and
 * throws on mismatch — the stub has to be able to fail.
 * ------------------------------------------------------------------ */

function makeContext(globalArgs: {
  baseUrl: string;
  githubRepo?: string;
  githubToken?: string;
  includePrereleases?: boolean;
  timeoutMs?: number;
}) {
  const written: { spec: string; name: string; data: Record<string, unknown> }[] = [];
  return {
    written,
    context: {
      globalArgs: {
        githubRepo: "open-webui/open-webui",
        includePrereleases: false,
        timeoutMs: 10000,
        ...globalArgs,
      },
      logger: { info: () => {}, warn: () => {} },
      // deno-lint-ignore require-await
      writeResource: async (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        const schema =
          (model.resources as Record<string, { schema: { parse: (d: unknown) => unknown } }>)[spec]
            ?.schema;
        if (!schema) throw new Error(`No such resource spec: ${spec}`);
        schema.parse(data); // throws on any shape the declared schema rejects
        written.push({ spec, name, data });
        return { name };
      },
    },
  };
}

const CONFIG_BODY = {
  name: "Open WebUI",
  version: "0.8.12",
  features: {
    auth: true,
    enable_api_keys: false,
    enable_signup: false,
    enable_websocket: true,
  },
};

function stubFetch(
  handler: (url: string) => { status?: number; body: unknown; headers?: Record<string, string> },
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status = 200, body, headers = {} } = handler(url);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test("sync writes an instance resource that satisfies the declared schema", async () => {
  const restore = stubFetch(() => ({ body: CONFIG_BODY }));
  try {
    const { context, written } = makeContext({ baseUrl: "http://localhost:3000" });
    const result = await model.methods.sync.execute({}, context);

    assertEquals(written.length, 1);
    assertEquals(written[0].spec, "instance");
    assertEquals(written[0].name, "instance-localhost-3000");
    assertEquals(written[0].data.version, "0.8.12");
    // The flag that decides whether any token-authenticated automation is
    // possible at all — it must survive into the resource, not be assumed.
    assertEquals(written[0].data.apiKeysEnabled, false);
    assertEquals(written[0].data.authEnabled, true);
    assertEquals(result.dataHandles.length, 1);
  } finally {
    restore();
  }
});

Deno.test("sync rejects a response with no version rather than storing a null", async () => {
  const restore = stubFetch(() => ({ body: { name: "Not OpenWebUI" } }));
  try {
    const { context } = makeContext({ baseUrl: "http://localhost:3000" });
    await assertRejects(
      () => model.methods.sync.execute({}, context),
      Error,
      "returned no version field",
    );
  } finally {
    restore();
  }
});

Deno.test("drift writes a drift resource that satisfies the declared schema", async () => {
  const restore = stubFetch((url) =>
    url.includes("api.github.com")
      ? {
        body: REAL_RELEASES.map((r) => ({
          tag_name: r.tag,
          draft: false,
          prerelease: false,
          published_at: r.publishedAt,
        })),
      }
      : { body: CONFIG_BODY }
  );
  try {
    const { context, written } = makeContext({ baseUrl: "http://localhost:3000" });
    await model.methods.drift.execute({}, context);

    assertEquals(written.length, 1);
    assertEquals(written[0].spec, "drift");
    assertEquals(written[0].name, "drift-localhost-3000");
    assertEquals(written[0].data.behind, true);
    assertEquals(written[0].data.releasesBehind, 11);
    assertEquals(written[0].data.latestVersion, "0.11.0");
    assertEquals(written[0].data.status, "behind");
  } finally {
    restore();
  }
});

Deno.test("drift drops prereleases and drafts by default", async () => {
  const restore = stubFetch((url) =>
    url.includes("api.github.com")
      ? {
        body: [
          { tag_name: "v0.12.0-rc1", draft: false, prerelease: true, published_at: null },
          { tag_name: "v0.12.1", draft: true, prerelease: false, published_at: null },
          { tag_name: "v0.11.0", draft: false, prerelease: false, published_at: null },
        ],
      }
      : { body: { ...CONFIG_BODY, version: "0.11.0" } }
  );
  try {
    const { context, written } = makeContext({ baseUrl: "http://localhost:3000" });
    await model.methods.drift.execute({}, context);
    // Neither the rc nor the draft may make a current instance look behind.
    assertEquals(written[0].data.status, "current");
    assertEquals(written[0].data.releasesBehind, 0);
  } finally {
    restore();
  }
});

Deno.test("drift surfaces an exhausted GitHub rate limit instead of reporting current", async () => {
  const restore = stubFetch((url) =>
    url.includes("api.github.com")
      ? {
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1785000000" },
      }
      : { body: CONFIG_BODY }
  );
  try {
    const { context } = makeContext({ baseUrl: "http://localhost:3000" });
    await assertRejects(
      () => model.methods.drift.execute({}, context),
      Error,
      "rate limit exhausted",
    );
  } finally {
    restore();
  }
});

Deno.test("drift reports a missing repo as a 404, not as an empty release list", async () => {
  const restore = stubFetch((url) =>
    url.includes("api.github.com")
      ? { status: 404, body: { message: "Not Found" } }
      : { body: CONFIG_BODY }
  );
  try {
    const { context } = makeContext({
      baseUrl: "http://localhost:3000",
      githubRepo: "open-webui/does-not-exist",
    });
    await assertRejects(
      () => model.methods.drift.execute({}, context),
      Error,
      "not found (404)",
    );
  } finally {
    restore();
  }
});
