/**
 * OpenWebUI instance — read a running {@link https://github.com/open-webui/open-webui | OpenWebUI}
 * and tell you whether it has fallen behind upstream.
 *
 * Two read-only methods. `sync` records what the instance actually is —
 * version and the feature flags that decide what any other automation can do
 * with it. `drift` compares that version against upstream's published releases
 * and reports how far behind it has drifted.
 *
 * Both endpoints it depends on are unauthenticated, which is why this model
 * needs no credentials at all: `/api/config` and `/api/version` answer before
 * login. That is a deliberate scope choice, not an oversight — anything that
 * manages users, models or settings needs an API key, and an instance can
 * have API keys switched off entirely, which no credential can work around.
 * `sync` reports that flag rather than assuming it.
 *
 * Three behaviours worth reading before use, each driven by how the real
 * services behave rather than by taste:
 *
 * 1. **Versions are compared numerically, never as strings.** OpenWebUI's
 *    versions break lexical ordering in both directions: `"0.8.12" > "0.11.0"`
 *    and `"0.8.12" < "0.8.9"` are both true as strings and both wrong. A string
 *    compare would have reported an instance eleven releases behind as current.
 *
 * 2. **A rate-limited GitHub is an error, not an empty release list.**
 *    Unauthenticated GitHub allows 60 requests/hour/IP and answers 403 when
 *    that runs out. Treating that as "no releases found" would report every
 *    instance as up to date precisely when the check stopped working.
 *
 * 3. **An unparseable running version throws.** Reporting "current" because the
 *    comparison could not be made is the failure mode this model exists to
 *    prevent.
 *
 * @module
 */
// extensions/models/openwebui_instance.ts
import { z } from "npm:zod@4";

const GlobalArgsSchema = z.object({
  baseUrl: z.string().url().describe(
    "Base URL of the OpenWebUI instance, e.g. http://localhost:3000",
  ),
  githubRepo: z.string().default("open-webui/open-webui").describe(
    "GitHub repo to read releases from, as owner/name. Override only if you track a fork.",
  ),
  // Sensitive so it never lands in a run log. Optional because the whole
  // model works unauthenticated — a token only raises the rate limit from
  // 60/hour to 5000/hour, which matters for a frequently-scheduled drift check.
  githubToken: z.string().optional().meta({ sensitive: true }).describe(
    "GitHub token, purely to raise the API rate limit. Needs no scopes for a public repo. Supply via vault.get().",
  ),
  includePrereleases: z.boolean().default(false).describe(
    "Count prereleases as upstream versions. Off by default: being 'behind' an rc is not actionable.",
  ),
  timeoutMs: z.number().int().positive().default(10000).describe(
    "Abort each HTTP call after this long. A drift check must never hang a workflow.",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InstanceSchema = z.object({
  url: z.string().describe("Base URL this reading came from"),
  version: z.string().describe("Version the instance reports running"),
  name: z.string().describe("Instance display name"),
  authEnabled: z.boolean().describe(
    "Whether the instance requires a login at all",
  ),
  apiKeysEnabled: z.boolean().describe(
    "Whether API keys can be issued. False means no token-authenticated automation is possible against this instance.",
  ),
  signupEnabled: z.boolean().describe(
    "Whether new accounts can self-register",
  ),
  websocketEnabled: z.boolean().describe(
    "Whether chat streams over a WebSocket. Relevant when putting a forward-auth proxy in front.",
  ),
  checkedAt: z.string(),
});

const DriftSchema = z.object({
  url: z.string(),
  runningVersion: z.string().describe("Version the instance reports"),
  latestVersion: z.string().describe(
    "Newest upstream release considered, tag normalised (no leading v)",
  ),
  latestPublishedAt: z.string().nullable().describe(
    "When the newest upstream release was published",
  ),
  status: z.enum(["current", "behind", "ahead"]).describe(
    "`ahead` means the instance runs something newer than any published release — normal on a :main build",
  ),
  behind: z.boolean().describe(
    "True when a newer upstream release exists. The single field to alert on.",
  ),
  releasesBehind: z.number().int().describe(
    "How many published releases are newer than the running version. A lower bound when `truncated` is true.",
  ),
  missedReleases: z.array(z.string()).describe(
    "Every release newer than the running version, newest first. This is the changelog you have not read.",
  ),
  truncated: z.boolean().describe(
    "True when the release page filled up before reaching the running version, so `releasesBehind` and `missedReleases` are incomplete. False means the counts are exact.",
  ),
  checkedAt: z.string(),
});

type Logger = {
  info: (message: string, props?: Record<string, unknown>) => void;
  warn: (message: string, props?: Record<string, unknown>) => void;
};

type Context = {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/* ------------------------------------------------------------------ *
 * Version handling
 *
 * OpenWebUI tags releases `v0.11.0` and reports `0.11.0`, so every
 * comparison crosses a normalisation boundary. Doing it numerically is
 * not pedantry: `"0.8.12" > "0.11.0"` is true as a string, and an
 * instance eleven releases behind would have been reported as current.
 * ------------------------------------------------------------------ */

/** A parsed semantic version. `prerelease` is null for a final release. */
export type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
};

/**
 * Parse a version string into comparable parts.
 *
 * Tolerates a leading `v` (GitHub tags carry one, the API does not), missing
 * minor/patch components, build metadata after `+`, and surrounding whitespace.
 *
 * @param raw Version or tag, e.g. `v0.11.0`, `0.8.12`, `0.11.0-rc1`.
 * @returns The parsed version, or null if it is not a recognisable version.
 */
export function parseVersion(raw: string): ParsedVersion | null {
  const cleaned = raw.trim().replace(/^v/i, "");
  if (cleaned === "") return null;

  // Split build metadata (+sha) first — it never participates in precedence.
  const [withoutBuild] = cleaned.split("+", 1);
  const dashAt = withoutBuild.indexOf("-");
  const core = dashAt === -1 ? withoutBuild : withoutBuild.slice(0, dashAt);
  const prerelease = dashAt === -1 ? null : withoutBuild.slice(dashAt + 1);

  const parts = core.split(".");
  if (parts.length === 0 || parts.length > 3) return null;

  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    nums.push(parseInt(p, 10));
  }

  return {
    major: nums[0],
    minor: nums[1] ?? 0,
    patch: nums[2] ?? 0,
    prerelease: prerelease === "" ? null : prerelease,
  };
}

/**
 * Compare two parsed versions by precedence.
 *
 * Follows semver: numeric fields dominate, and a prerelease sorts *below* the
 * final release it precedes — `0.11.0-rc1 < 0.11.0`. Two prereleases of the
 * same core version are compared as plain strings, which is enough to order
 * `rc1` before `rc2` and is not worth more than that here.
 *
 * @returns Negative if a < b, positive if a > b, zero if equal.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  // Equal cores: a prerelease is older than the release itself.
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return a.prerelease < b.prerelease ? -1 : a.prerelease > b.prerelease ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Resource naming
 *
 * writeResource instance names live in ONE flat namespace across every
 * spec — two specs writing the same name overwrite each other on disk,
 * silently, with nothing failing at validation or in tests. Both names
 * below are therefore spec-prefixed, and a test asserts they can never
 * collide for any input.
 * ------------------------------------------------------------------ */

/**
 * Reduce a base URL to a short stable label usable in a resource name.
 *
 * Keeps host and port so two instances on the same host stay distinct, and
 * replaces everything outside `[A-Za-z0-9._-]` so the result is path-safe.
 */
export function hostLabel(baseUrl: string): string {
  let host: string;
  try {
    const u = new URL(baseUrl);
    host = u.port ? `${u.hostname}-${u.port}` : u.hostname;
  } catch {
    host = baseUrl;
  }
  return host.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** Resource name for the `instance` spec. Spec-prefixed — see above. */
export function instanceResourceName(baseUrl: string): string {
  return `instance-${hostLabel(baseUrl)}`;
}

/** Resource name for the `drift` spec. Spec-prefixed — see above. */
export function driftResourceName(baseUrl: string): string {
  return `drift-${hostLabel(baseUrl)}`;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

type OpenWebUIConfig = {
  name?: string;
  version?: string;
  features?: Record<string, unknown>;
};

/**
 * Trim an error response body to something loggable.
 *
 * An HTML error page or a long JSON blob in an exception message buries the
 * status code that actually identifies the problem.
 */
function summarise(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * Read `/api/config` from the instance.
 *
 * This endpoint answers before login, which is what lets the whole model run
 * unauthenticated. It carries both the version and the feature flags, so one
 * call covers everything `sync` needs.
 */
async function readConfig(
  globalArgs: GlobalArgs,
): Promise<OpenWebUIConfig> {
  const base = globalArgs.baseUrl.replace(/\/+$/, "");
  const url = `${base}/api/config`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(globalArgs.timeoutMs),
    });
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError"
      ? `timed out after ${globalArgs.timeoutMs}ms`
      : String(cause);
    throw new Error(`OpenWebUI GET ${url} failed: ${reason}`);
  }

  if (!res.ok) {
    // Read the body rather than discarding it: it is the difference between
    // "something went wrong" and a usable error, and leaving it unconsumed
    // holds the connection open.
    throw new Error(
      `OpenWebUI GET ${url} failed: ${res.status} ${res.statusText} ${
        summarise(await res.text())
      }`,
    );
  }

  const body = await res.json() as OpenWebUIConfig;

  // A config without a version is not a usable reading. Writing null through
  // to a drift comparison would produce a confident wrong answer later.
  if (typeof body.version !== "string" || body.version === "") {
    throw new Error(
      `OpenWebUI GET ${url} returned no version field — is ${base} really an OpenWebUI instance?`,
    );
  }

  return body;
}

type GitHubRelease = {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
};

/**
 * Releases fetched per call.
 *
 * Deliberately one page, not a full walk: repos accumulate hundreds of
 * releases (open-webui has 167) and paginating them all would burn the
 * unauthenticated 60/hour budget several requests at a time to answer a
 * question the first page almost always settles. The cost of the shortcut is
 * that counts can be a lower bound, which is why `truncated` exists rather
 * than being left for the caller to guess.
 */
const PER_PAGE = 100;

/**
 * List published releases for the configured repo, newest first.
 *
 * Drafts are always dropped; prereleases follow `includePrereleases`.
 *
 * A 403 with the rate-limit header exhausted is raised as its own error rather
 * than folded into "no releases": an empty list would make every instance look
 * current at exactly the moment the check stopped working.
 */
async function listReleases(
  globalArgs: GlobalArgs,
): Promise<{ releases: GitHubRelease[]; capped: boolean }> {
  const url =
    `https://api.github.com/repos/${globalArgs.githubRepo}/releases?per_page=${PER_PAGE}`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    // GitHub rejects requests with no User-Agent.
    "User-Agent": "swamp-openwebui-instance",
  };
  if (globalArgs.githubToken) {
    headers.Authorization = `Bearer ${globalArgs.githubToken}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(globalArgs.timeoutMs),
    });
  } catch (cause) {
    const reason = cause instanceof Error && cause.name === "TimeoutError"
      ? `timed out after ${globalArgs.timeoutMs}ms`
      : String(cause);
    throw new Error(`GitHub GET ${url} failed: ${reason}`);
  }

  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0") {
      const reset = res.headers.get("x-ratelimit-reset");
      const resetAt = reset
        ? new Date(parseInt(reset, 10) * 1000).toISOString()
        : "unknown";
      await res.body?.cancel();
      throw new Error(
        `GitHub API rate limit exhausted (resets ${resetAt}). ` +
          `Unauthenticated requests are capped at 60/hour per IP — ` +
          `set githubToken to raise it to 5000/hour.`,
      );
    }
  }

  if (res.status === 404) {
    await res.body?.cancel();
    throw new Error(
      `GitHub repo "${globalArgs.githubRepo}" not found (404). Check githubRepo.`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `GitHub GET ${url} failed: ${res.status} ${res.statusText} ${
        summarise(await res.text())
      }`,
    );
  }

  const all = await res.json() as GitHubRelease[];

  // Capped is measured on the RAW page, before filtering: a page of 100 that
  // filters down to 40 still means there is a page 2. open-webui alone has 167
  // releases, so this is the normal case, not a corner one.
  return {
    releases: all.filter((r) =>
      !r.draft && (globalArgs.includePrereleases || !r.prerelease)
    ),
    capped: all.length >= PER_PAGE,
  };
}

/**
 * Compare a running version against a set of releases.
 *
 * Split out from `execute` so the comparison — the part that is actually easy
 * to get wrong — is testable without a network.
 *
 * @throws If the running version cannot be parsed. Reporting "current" because
 * the comparison could not be made would defeat the purpose of the model.
 */
export function computeDrift(
  runningVersion: string,
  releases: { tag: string; publishedAt: string | null }[],
  capped = false,
): {
  status: "current" | "behind" | "ahead";
  behind: boolean;
  releasesBehind: number;
  missedReleases: string[];
  truncated: boolean;
  latestVersion: string;
  latestPublishedAt: string | null;
} {
  const running = parseVersion(runningVersion);
  if (running === null) {
    throw new Error(
      `Cannot parse running version "${runningVersion}" as a version, so no ` +
        `comparison is possible. Refusing to report a drift status that would be a guess.`,
    );
  }

  const parsed = releases
    .map((r) => ({ ...r, parsed: parseVersion(r.tag) }))
    .filter((r): r is typeof r & { parsed: ParsedVersion } => r.parsed !== null)
    .sort((a, b) => compareVersions(b.parsed, a.parsed));

  if (parsed.length === 0) {
    throw new Error(
      "No parseable releases returned for the configured repo — nothing to compare against.",
    );
  }

  const newest = parsed[0];
  const oldest = parsed[parsed.length - 1];
  const missed = parsed.filter((r) => compareVersions(r.parsed, running) > 0);
  const cmp = compareVersions(running, newest.parsed);

  // The counts are exact only if the fetched window reaches back past the
  // running version. If the page filled up while every release on it is still
  // newer than what is running, there are older-but-still-newer releases we
  // never saw, and `releasesBehind` is a floor rather than a total.
  const truncated = capped && compareVersions(oldest.parsed, running) > 0;

  return {
    status: cmp === 0 ? "current" : cmp < 0 ? "behind" : "ahead",
    behind: missed.length > 0,
    releasesBehind: missed.length,
    missedReleases: missed.map((r) => r.tag),
    truncated,
    latestVersion: normaliseTag(newest.tag),
    latestPublishedAt: newest.publishedAt,
  };
}

/** Strip a leading `v` so reported versions match what the instance reports. */
export function normaliseTag(tag: string): string {
  return tag.trim().replace(/^v/i, "");
}

/** Read a boolean feature flag, defaulting to false when absent. */
function flag(features: Record<string, unknown> | undefined, key: string) {
  return features?.[key] === true;
}

/**
 * Model type `@sntxrr/openwebui/instance`.
 *
 * @example
 * ```bash
 * swamp model create @sntxrr/openwebui/instance openwebui \
 *   --global-arg baseUrl=http://localhost:3000
 * swamp model @sntxrr/openwebui/instance method run sync openwebui
 * swamp model @sntxrr/openwebui/instance method run drift openwebui
 * ```
 */
export const model = {
  type: "@sntxrr/openwebui/instance",
  description:
    "Read a running OpenWebUI instance and report how far its version has drifted behind upstream releases. Read-only, and needs no credentials — both endpoints it uses answer before login.",
  version: "2026.08.06.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    instance: {
      description:
        "What the instance reports about itself: version and the feature flags that decide what automation can do with it.",
      schema: InstanceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    drift: {
      description:
        "Comparison of the running version against upstream's published releases.",
      schema: DriftSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },
  methods: {
    sync: {
      description:
        "Read the instance's version and feature flags. Read-only, unauthenticated.",
      arguments: z.object({}),
      execute: async (_args: Record<never, never>, context: Context) => {
        const { globalArgs, logger } = context;
        logger.info("Reading OpenWebUI config from {url}", {
          url: globalArgs.baseUrl,
        });

        const config = await readConfig(globalArgs);
        const features = config.features as Record<string, unknown> | undefined;

        logger.info("OpenWebUI at {url} reports version {version}", {
          url: globalArgs.baseUrl,
          version: config.version,
        });

        const apiKeysEnabled = flag(features, "enable_api_keys");
        if (!apiKeysEnabled) {
          // Worth saying out loud: this is the flag that blocks every
          // token-authenticated integration, and no credential works around it.
          logger.warn(
            "API keys are disabled on {url} — no token-authenticated automation can reach it",
            { url: globalArgs.baseUrl },
          );
        }

        const handle = await context.writeResource(
          "instance",
          instanceResourceName(globalArgs.baseUrl),
          {
            url: globalArgs.baseUrl,
            version: config.version as string,
            name: config.name ?? "Open WebUI",
            authEnabled: flag(features, "auth"),
            apiKeysEnabled,
            signupEnabled: flag(features, "enable_signup"),
            websocketEnabled: flag(features, "enable_websocket"),
            checkedAt: new Date().toISOString(),
          },
        );

        return { dataHandles: [handle] };
      },
    },

    drift: {
      description:
        "Compare the running version against upstream's published releases and report how far behind it is. Read-only; writes nothing to the instance.",
      arguments: z.object({}),
      execute: async (_args: Record<never, never>, context: Context) => {
        const { globalArgs, logger } = context;
        logger.info(
          "Checking {url} for drift against {repo} releases",
          { url: globalArgs.baseUrl, repo: globalArgs.githubRepo },
        );

        const config = await readConfig(globalArgs);
        const runningVersion = config.version as string;

        const { releases, capped } = await listReleases(globalArgs);
        logger.info(
          "Comparing {running} against {count} releases from {repo}",
          {
            running: runningVersion,
            count: releases.length,
            repo: globalArgs.githubRepo,
          },
        );

        const result = computeDrift(
          runningVersion,
          releases.map((r) => ({
            tag: r.tag_name,
            publishedAt: r.published_at,
          })),
          capped,
        );

        if (result.truncated) {
          logger.warn(
            "Release list was capped at {perPage} before reaching {running} — " +
              "releasesBehind is a lower bound, not a total",
            { perPage: PER_PAGE, running: runningVersion },
          );
        }

        if (result.behind) {
          logger.warn(
            "{url} is {n} releases behind: running {running}, latest {latest}",
            {
              url: globalArgs.baseUrl,
              n: result.releasesBehind,
              running: runningVersion,
              latest: result.latestVersion,
            },
          );
        } else {
          logger.info("{url} is up to date on {running}", {
            url: globalArgs.baseUrl,
            running: runningVersion,
          });
        }

        const handle = await context.writeResource(
          "drift",
          driftResourceName(globalArgs.baseUrl),
          {
            url: globalArgs.baseUrl,
            runningVersion,
            latestVersion: result.latestVersion,
            latestPublishedAt: result.latestPublishedAt,
            status: result.status,
            behind: result.behind,
            releasesBehind: result.releasesBehind,
            missedReleases: result.missedReleases,
            truncated: result.truncated,
            checkedAt: new Date().toISOString(),
          },
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
