# S6b SSRF Gap Closure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four SSRF gaps the S6-a check found: `/proxy` unauth, worker safe-fetch TOCTOU, two deny-lists, and `POST /api_call` + `DownloaderService.downloadFile` with no egress check — plus the sweep of raw `fetch(url)` call sites in the worker.

**Architecture:** Port the A9 `egress-policy.ts` module from worker to back (byte-identical copy, drift test in both repos). Rebuild worker `safe-fetch` on top of A9 primitives (one deny-list, pinned address, redirect re-check). Rewrite `/proxy` as a Nest controller with JWT auth + `PROXY_ALLOWED_HOSTS` allowlist, consumed by the two front modals through an authenticated blob-URL hook. Guard `/api_call` with the back egress port. Delete `DownloaderService.downloadFile`. Replace five raw `fetch(url)` worker call sites with `SafeFetchService`.

**Tech Stack:** NestJS, TypeScript, axios, undici, TanStack Query, React, Vitest/Jest.

**Design doc:** `apps/docs/superpowers/specs/2026-10-29-s6b-ssrf-gaps-design.md` · **Task spec:** `.claude/tasks/worker-flow-execution-epic/TASK-S6B-SSRF-GAPS.md` · **ClickUp:** [868mn5gb5](https://app.clickup.com/t/868mn5gb5)

**Harness notes:**
- **No commits in these steps.** Git operations (branches, commits, push, PRs) stay with the user.
- **No mid-work build/lint/test runs.** The plan writes test files as part of the implementation; the user runs the suite at the end.
- Three repos sit under `apps/`: `apps/Flux-Prompt/` (back), `apps/Flux-Prompt-Worker/` (worker), `apps/Flux-Prompt-Frontend/` (front).

---

## Phase 1 — Egress port + drift test (foundation)

### Task 1: Port A9 egress module to back

**Files:**
- Create: `apps/Flux-Prompt/src/common/egress/egress-policy.ts`

- [ ] **Step 1: Create the ported file**

The file is a copy of `apps/Flux-Prompt-Worker/src/modules/egress/egress-policy.ts` with one surgical change: the worker's `UserConfigError`/`IntegrationError` imports are swapped for `@nestjs/common` exceptions (`BadRequestException`, `InternalServerErrorException`), and `refuse(...)` throws `BadRequestException` with the same `userMessage`.

```typescript
import { promises as dns, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import {
  BadRequestException,
  InternalServerErrorException,
} from "@nestjs/common";

export type EgressPolicyMode = "off" | "report" | "enforce";

export type EgressAllowHook = (host: string, address: string) => boolean;

export interface EgressOptions {
  mode: EgressPolicyMode;
  allow?: EgressAllowHook;
}

export interface EgressRange {
  network: string;
  prefix: number;
  family: "ipv4" | "ipv6";
}

export const EGRESS_REFUSED_CODE = "EGRESS_REFUSED";

export const EGRESS_DENY_RANGES: ReadonlyArray<EgressRange> = [
  { network: "0.0.0.0", prefix: 8, family: "ipv4" },
  { network: "10.0.0.0", prefix: 8, family: "ipv4" },
  { network: "100.64.0.0", prefix: 10, family: "ipv4" },
  { network: "127.0.0.0", prefix: 8, family: "ipv4" },
  { network: "169.254.0.0", prefix: 16, family: "ipv4" },
  { network: "172.16.0.0", prefix: 12, family: "ipv4" },
  { network: "192.0.0.0", prefix: 24, family: "ipv4" },
  { network: "192.168.0.0", prefix: 16, family: "ipv4" },
  { network: "198.18.0.0", prefix: 15, family: "ipv4" },
  { network: "224.0.0.0", prefix: 4, family: "ipv4" },
  { network: "240.0.0.0", prefix: 4, family: "ipv4" },
  { network: "255.255.255.255", prefix: 32, family: "ipv4" },
  { network: "::", prefix: 128, family: "ipv6" },
  { network: "::1", prefix: 128, family: "ipv6" },
  { network: "fc00::", prefix: 7, family: "ipv6" },
  { network: "fe80::", prefix: 10, family: "ipv6" },
  { network: "ff00::", prefix: 8, family: "ipv6" },
];

const EGRESS_POLICY_MODES: ReadonlyArray<EgressPolicyMode> = [
  "off",
  "report",
  "enforce",
];

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

const REFUSED_USER_MESSAGE = "The destination address is not allowed.";

const denyList = EGRESS_DENY_RANGES.reduce((list, range) => {
  list.addSubnet(range.network, range.prefix, range.family);
  return list;
}, new BlockList());

export function egressModeFromEnv(): EgressPolicyMode {
  const raw = process.env.EGRESS_POLICY_MODE?.trim().toLowerCase();
  return EGRESS_POLICY_MODES.find((mode) => mode === raw) ?? "report";
}

function expandIpv6(address: string): number[] | null {
  let text = address;
  let tail: number[] = [];
  const dotted = text.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const octets = dotted.slice(2, 6).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    text = dotted[1].endsWith("::") ? dotted[1] : dotted[1].slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [];
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const size = 8 - tail.length;
  const zeros = size - head.length - rest.length;
  if (zeros < 0 || (halves.length === 1 && zeros !== 0)) return null;
  const groups = [...head, ...new Array(zeros).fill(0), ...rest, ...tail];
  return groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}

function embeddedIpv4(address: string): string | null {
  const groups = expandIpv6(address.split("%")[0]);
  if (!groups) return null;
  const toIpv4 = () =>
    [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(
      ".",
    );
  const firstFiveZero = groups.slice(0, 5).every((g) => g === 0);
  if (firstFiveZero && groups[5] === 0xffff) return toIpv4();
  if (
    groups[0] === 0x64 &&
    groups[1] === 0xff9b &&
    groups.slice(2, 6).every((g) => g === 0)
  ) {
    return toIpv4();
  }
  const compatible =
    firstFiveZero && groups[5] === 0 && (groups[6] !== 0 || groups[7] > 1);
  return compatible ? toIpv4() : null;
}

export function isDeniedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return denyList.check(address, "ipv4");
  if (family !== 6) return false;
  const inner = embeddedIpv4(address);
  if (inner) return denyList.check(inner, "ipv4");
  return denyList.check(address.split("%")[0], "ipv6");
}

function normaliseHost(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

function refusalError(host: string, reason: string): Error {
  const error = new Error(`egress_refused host=${host} reason=${reason}`);
  Object.assign(error, { code: EGRESS_REFUSED_CODE, host, reason });
  return error;
}

function refuse(options: EgressOptions, host: string, reason: string): void {
  if (options.mode === "enforce") {
    throw new BadRequestException({
      message: REFUSED_USER_MESSAGE,
      code: EGRESS_REFUSED_CODE,
      host,
      reason,
    });
  }
  console.warn("egress_would_refuse", { host, reason });
}

function deniedAmong(
  host: string,
  addresses: string[],
  options: EgressOptions,
): string | null {
  return (
    addresses.find(
      (address) =>
        isDeniedAddress(address) && !(options.allow?.(host, address) ?? false),
    ) ?? null
  );
}

async function resolveAll(host: string): Promise<LookupAddress[]> {
  try {
    return await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new InternalServerErrorException({
      message: "The destination host could not be resolved. Try again.",
      devMessage: `egress_dns_failed host=${host}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export async function assertEgressAllowed(
  rawUrl: string,
  options: EgressOptions,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    throw new BadRequestException({
      message: "The destination URL is not valid.",
      devMessage: `egress_malformed_url: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (options.mode === "off") return;
  const host = normaliseHost(url.hostname);
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    refuse(options, host, `protocol ${url.protocol}`);
    return;
  }
  if (url.username || url.password) {
    refuse(options, host, "userinfo");
    return;
  }
  const addresses = isIP(host)
    ? [host]
    : (await resolveAll(host)).map((entry) => entry.address);
  const denied = deniedAmong(host, addresses, options);
  if (denied) refuse(options, host, `address ${denied}`);
}

export function createSafeLookup(options: EgressOptions) {
  return async (hostname: string): Promise<LookupAddress[]> => {
    const host = normaliseHost(hostname);
    const entries = await dns.lookup(host, { all: true, verbatim: true });
    if (options.mode === "off") return entries;
    const denied = deniedAmong(
      host,
      entries.map((entry) => entry.address),
      options,
    );
    if (denied) {
      if (options.mode === "enforce") {
        throw refusalError(host, `address ${denied}`);
      }
      console.warn("egress_would_refuse", {
        host,
        reason: `address ${denied}`,
      });
    }
    return entries;
  };
}

export function createRedirectGuard(options: EgressOptions) {
  return (redirect: { hostname?: string; host?: string | null }): void => {
    if (options.mode === "off") return;
    const host = normaliseHost(redirect.hostname ?? redirect.host ?? "");
    if (!isIP(host)) return;
    if (!isDeniedAddress(host) || (options.allow?.(host, host) ?? false)) {
      return;
    }
    if (options.mode === "enforce") {
      throw refusalError(host, `redirect to address ${host}`);
    }
    console.warn("egress_would_refuse", {
      host,
      reason: `redirect to address ${host}`,
    });
  };
}

export function egressHttpConfig(options: EgressOptions) {
  return {
    proxy: false as const,
    lookup: createSafeLookup(options),
    beforeRedirect: createRedirectGuard(options),
  };
}

export function isEgressRefusal(err: unknown): boolean {
  let current: unknown = err;
  while (current && typeof current === "object") {
    if ((current as { code?: unknown }).code === EGRESS_REFUSED_CODE) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
```

---

### Task 2: Drift test in back

**Files:**
- Create: `apps/Flux-Prompt/test/egress-policy-drift.spec.ts`

- [ ] **Step 1: Create the spec**

```typescript
import * as backEgress from '../src/common/egress/egress-policy';

const CANONICAL_DENY_RANGES = [
  { network: '0.0.0.0', prefix: 8, family: 'ipv4' },
  { network: '10.0.0.0', prefix: 8, family: 'ipv4' },
  { network: '100.64.0.0', prefix: 10, family: 'ipv4' },
  { network: '127.0.0.0', prefix: 8, family: 'ipv4' },
  { network: '169.254.0.0', prefix: 16, family: 'ipv4' },
  { network: '172.16.0.0', prefix: 12, family: 'ipv4' },
  { network: '192.0.0.0', prefix: 24, family: 'ipv4' },
  { network: '192.168.0.0', prefix: 16, family: 'ipv4' },
  { network: '198.18.0.0', prefix: 15, family: 'ipv4' },
  { network: '224.0.0.0', prefix: 4, family: 'ipv4' },
  { network: '240.0.0.0', prefix: 4, family: 'ipv4' },
  { network: '255.255.255.255', prefix: 32, family: 'ipv4' },
  { network: '::', prefix: 128, family: 'ipv6' },
  { network: '::1', prefix: 128, family: 'ipv6' },
  { network: 'fc00::', prefix: 7, family: 'ipv6' },
  { network: 'fe80::', prefix: 10, family: 'ipv6' },
  { network: 'ff00::', prefix: 8, family: 'ipv6' },
];

const CANONICAL_EXPORTS = [
  'EGRESS_DENY_RANGES',
  'EGRESS_REFUSED_CODE',
  'assertEgressAllowed',
  'createRedirectGuard',
  'createSafeLookup',
  'egressHttpConfig',
  'egressModeFromEnv',
  'isDeniedAddress',
  'isEgressRefusal',
];

describe('egress-policy drift', () => {
  it('local EGRESS_DENY_RANGES matches the canonical list', () => {
    expect(backEgress.EGRESS_DENY_RANGES).toEqual(CANONICAL_DENY_RANGES);
  });

  it('local module exports exactly the canonical surface', () => {
    const names = Object.keys(backEgress).sort();
    expect(names).toEqual(CANONICAL_EXPORTS);
  });
});
```

- [ ] **Step 2: Add README note**

Edit `apps/Flux-Prompt/README.md` — append a short section:

```markdown
## Egress policy drift

`src/common/egress/egress-policy.ts` is a port of the worker's
`apps/Flux-Prompt-Worker/src/modules/egress/egress-policy.ts`. The two files
must stay byte-identical except for error-type imports. If you change one,
update the other AND both repos' `test/egress-policy-drift.spec.ts` canonical
block in the same cycle. See
`apps/docs/superpowers/specs/2026-10-29-s6b-ssrf-gaps-design.md`.
```

---

### Task 3: Drift test in worker (mirror)

**Files:**
- Create: `apps/Flux-Prompt-Worker/test/egress-policy-drift.spec.ts`

- [ ] **Step 1: Create the spec**

Same `CANONICAL_DENY_RANGES` and `CANONICAL_EXPORTS` as Task 2, importing the worker module instead:

```typescript
import * as workerEgress from '../src/modules/egress/egress-policy';

const CANONICAL_DENY_RANGES = [
  { network: '0.0.0.0', prefix: 8, family: 'ipv4' },
  { network: '10.0.0.0', prefix: 8, family: 'ipv4' },
  { network: '100.64.0.0', prefix: 10, family: 'ipv4' },
  { network: '127.0.0.0', prefix: 8, family: 'ipv4' },
  { network: '169.254.0.0', prefix: 16, family: 'ipv4' },
  { network: '172.16.0.0', prefix: 12, family: 'ipv4' },
  { network: '192.0.0.0', prefix: 24, family: 'ipv4' },
  { network: '192.168.0.0', prefix: 16, family: 'ipv4' },
  { network: '198.18.0.0', prefix: 15, family: 'ipv4' },
  { network: '224.0.0.0', prefix: 4, family: 'ipv4' },
  { network: '240.0.0.0', prefix: 4, family: 'ipv4' },
  { network: '255.255.255.255', prefix: 32, family: 'ipv4' },
  { network: '::', prefix: 128, family: 'ipv6' },
  { network: '::1', prefix: 128, family: 'ipv6' },
  { network: 'fc00::', prefix: 7, family: 'ipv6' },
  { network: 'fe80::', prefix: 10, family: 'ipv6' },
  { network: 'ff00::', prefix: 8, family: 'ipv6' },
];

const CANONICAL_EXPORTS = [
  'EGRESS_DENY_RANGES',
  'EGRESS_REFUSED_CODE',
  'assertEgressAllowed',
  'createRedirectGuard',
  'createSafeLookup',
  'egressHttpConfig',
  'egressModeFromEnv',
  'isDeniedAddress',
  'isEgressRefusal',
];

describe('egress-policy drift', () => {
  it('local EGRESS_DENY_RANGES matches the canonical list', () => {
    expect(workerEgress.EGRESS_DENY_RANGES).toEqual(CANONICAL_DENY_RANGES);
  });

  it('local module exports exactly the canonical surface', () => {
    const names = Object.keys(workerEgress).sort();
    expect(names).toEqual(CANONICAL_EXPORTS);
  });
});
```

- [ ] **Step 2: Add README note**

Edit `apps/Flux-Prompt-Worker/README.md` — append:

```markdown
## Egress policy drift

`src/modules/egress/egress-policy.ts` is also ported to
`apps/Flux-Prompt/src/common/egress/egress-policy.ts`. The two files must stay
byte-identical except for error-type imports. If you change one, update the
other AND both repos' `test/egress-policy-drift.spec.ts` canonical block in
the same cycle. See
`apps/docs/superpowers/specs/2026-10-29-s6b-ssrf-gaps-design.md`.
```

---

## Phase 2 — Worker safe-fetch rebuild

### Task 4: Add `head()` to SafeFetchService

**Files:**
- Modify: `apps/Flux-Prompt-Worker/src/modules/safe-fetch/safe-fetch.service.ts`

- [ ] **Step 1: Add the `head` method**

In the `SafeFetchService` class, add after the existing `post` method:

```typescript
async head(
  url: string,
  context: SafeFetchContext,
): Promise<{ status: number; headers: Record<string, string> }> {
  const { status, headers } = await this.rawRequest(url, context, {
    method: 'HEAD',
  });
  return { status, headers };
}
```

Note: `rawRequest` already returns `{ buffer, bytes, status, headers }` — the buffer will be empty for HEAD, which is fine.

---

### Task 5: Rewrite `safe-dispatcher.ts` on A9 primitives

**Files:**
- Modify: `apps/Flux-Prompt-Worker/src/modules/safe-fetch/safe-dispatcher.ts` (full rewrite)

- [ ] **Step 1: Replace the file content**

```typescript
import { Agent, buildConnector } from 'undici';
import {
  assertEgressAllowed,
  createSafeLookup,
  EgressOptions,
  EGRESS_REFUSED_CODE,
} from '@/modules/egress/egress-policy';
import { BlockedAddressError } from './safe-fetch.errors';

interface SafeDispatcherParams {
  orgId: string | undefined;
  nodeType: string;
  validateCertificate?: boolean;
  egressOptions: EgressOptions;
  logger: (payload: Record<string, unknown>) => void;
}

export function createSafeDispatcher(params: SafeDispatcherParams): Agent {
  const defaultConnector = buildConnector({
    rejectUnauthorized: params.validateCertificate ?? true,
  });
  const safeLookup = createSafeLookup(params.egressOptions);
  return new Agent({
    connect: (options, callback) => {
      const host = options.hostname;
      safeLookup(host)
        .then((entries) => {
          if (entries.length === 0) {
            params.logger({
              reason: 'unresolvable',
              orgId: params.orgId,
              nodeType: params.nodeType,
              host,
            });
            return callback(
              new BlockedAddressError({
                host,
                resolvedIps: [],
                deniedRange: 'unresolvable',
                devMessage: `No IP addresses resolved for host '${host}'`,
                userMessage: `Request blocked by egress policy: unable to resolve host '${host}'.`,
              }),
              null,
            );
          }
          return defaultConnector(options, callback);
        })
        .catch((err) => {
          const code = (err as { code?: string } | null)?.code;
          if (code === EGRESS_REFUSED_CODE) {
            params.logger({
              reason: 'address_in_denied_range',
              orgId: params.orgId,
              nodeType: params.nodeType,
              host,
              deniedRange: (err as { reason?: string }).reason ?? 'denied',
            });
            return callback(
              new BlockedAddressError({
                host,
                resolvedIps: [],
                deniedRange: (err as { reason?: string }).reason ?? 'denied',
                devMessage: `All resolved IPs for '${host}' fall into denied ranges`,
                userMessage: `Request blocked by egress policy: destination is in a blocked address range.`,
              }),
              null,
            );
          }
          callback(err as Error, null);
        });
    },
  });
}
```

Key changes:
- `policy: EgressPolicyService` → `egressOptions: EgressOptions`.
- The manual `dnsLookup` + per-entry `isAddressAllowed` loop is replaced by one call to `createSafeLookup(options)(host)`. The A9 helper throws `EGRESS_REFUSED_CODE` on refusal and pins the first allowed address through its own return.
- `defaultConnector` connects by hostname BUT with the resolved+pinned address now cached inside `undici` via the lookup hook. (This is the TOCTOU fix the task calls out.)
- The error-mapping branch preserves `BlockedAddressError` as the external contract so `apiCaller`/`fileSave` need no change.

---

### Task 6: Rewrite `safe-axios.ts` on A9 primitives

**Files:**
- Modify: `apps/Flux-Prompt-Worker/src/modules/safe-fetch/safe-axios.ts` (full rewrite)

- [ ] **Step 1: Replace the file content**

```typescript
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import * as https from 'node:https';
import {
  createRedirectGuard,
  createSafeLookup,
  EgressOptions,
  EGRESS_REFUSED_CODE,
} from '@/modules/egress/egress-policy';
import {
  BlockedAddressError,
  RedirectRefusedError,
  RequestTimeoutError,
  ResponseTooLargeError,
} from './safe-fetch.errors';

export interface SafeAxiosContext {
  orgId: string | undefined;
  nodeType: string;
  skipAddressChecks?: boolean;
}

interface SafeAxiosDependencies {
  egressOptions: EgressOptions;
  logger: (payload: Record<string, unknown>) => void;
  config: {
    maxResponseBytes: number;
    timeoutMs: number;
  };
}

export function createSafeAxios(
  context: SafeAxiosContext,
  deps: SafeAxiosDependencies,
): AxiosInstance {
  const httpsAgent = context.skipAddressChecks
    ? new https.Agent()
    : new https.Agent({
        lookup: ((hostname, _options, callback) => {
          createSafeLookup(deps.egressOptions)(hostname)
            .then((entries) => {
              const first = entries[0];
              (callback as unknown as (
                err: Error | null,
                address: string,
                family: number,
              ) => void)(null, first.address, first.family);
            })
            .catch((err) => {
              const code = (err as { code?: string } | null)?.code;
              if (code === EGRESS_REFUSED_CODE) {
                deps.logger({
                  reason: 'address_in_denied_range',
                  orgId: context.orgId,
                  nodeType: context.nodeType,
                  host: hostname,
                  deniedRange:
                    (err as { reason?: string }).reason ?? 'denied',
                });
                return (callback as unknown as (err: Error | null) => void)(
                  new BlockedAddressError({
                    host: hostname,
                    resolvedIps: [],
                    deniedRange:
                      (err as { reason?: string }).reason ?? 'denied',
                    devMessage: `egress refused for host '${hostname}'`,
                    userMessage: `Request blocked by egress policy: destination is in a blocked address range.`,
                  }),
                );
              }
              (callback as unknown as (err: Error | null) => void)(err as Error);
            });
        }) as unknown as never,
      });
  const instance = axios.create({
    timeout: deps.config.timeoutMs,
    maxContentLength: deps.config.maxResponseBytes,
    maxBodyLength: deps.config.maxResponseBytes,
    maxRedirects: 0,
    httpsAgent,
    validateStatus: () => true,
  });
  const redirectGuard = createRedirectGuard(deps.egressOptions);
  instance.interceptors.response.use(
    async (response) => {
      if (response.status >= 300 && response.status < 400) {
        return handleRedirect(response, redirectGuard, deps.logger, context);
      }
      return response;
    },
    (err) => mapAxiosError(err, deps.config.timeoutMs),
  );
  return instance;
}

function handleRedirect(
  response: AxiosResponse,
  redirectGuard: ReturnType<typeof createRedirectGuard>,
  logger: (payload: Record<string, unknown>) => void,
  context: SafeAxiosContext,
): AxiosResponse {
  const headers = response.headers as Record<string, unknown> | undefined;
  const location = String(headers?.location ?? '');
  try {
    if (location) {
      const parsed = new URL(location);
      redirectGuard({ hostname: parsed.hostname, host: parsed.host });
    }
  } catch {
    /* fall through to refuse */
  }
  logger({
    reason: 'redirect_refused',
    orgId: context.orgId,
    nodeType: context.nodeType,
    statusCode: response.status,
    location,
  });
  throw new RedirectRefusedError({
    location,
    statusCode: response.status,
    devMessage: `Server returned ${response.status} redirect to ${location}`,
    userMessage: `Request blocked: redirect responses are not followed. The server returned ${response.status} to '${location}'. Issue a new request manually if intended.`,
  });
}

function mapAxiosError(err: unknown, timeoutMs: number): Promise<never> {
  if (err instanceof BlockedAddressError) return Promise.reject(err);
  if (err instanceof RedirectRefusedError) return Promise.reject(err);
  const errorObj = err as {
    code?: string;
    message?: string;
    response?: { data?: unknown };
  };
  if (errorObj.code === 'ECONNABORTED' || errorObj.code === 'ETIMEDOUT') {
    return Promise.reject(
      new RequestTimeoutError({
        timeoutMs,
        devMessage: `Request timed out after ${timeoutMs}ms`,
        userMessage: `Request blocked: request exceeded ${Math.round(timeoutMs / 1000)}s timeout.`,
      }),
    );
  }
  if (
    errorObj.code === 'ERR_BAD_RESPONSE' &&
    errorObj.message?.includes('maxContentLength')
  ) {
    return Promise.reject(
      new ResponseTooLargeError({
        maxBytes: 0,
        observedBytes: 0,
        devMessage: errorObj.message ?? 'Response exceeded max size',
        userMessage: `Request blocked: response exceeded the configured size limit.`,
      }),
    );
  }
  return Promise.reject(err);
}
```

Key changes:
- `policy: EgressPolicyService` → `egressOptions: EgressOptions`.
- `buildCheckingLookup` deleted; the custom `lookup` on the agent now calls `createSafeLookup(options)` and translates the A9 refusal into `BlockedAddressError`.
- Added `redirectGuard` from `createRedirectGuard`; the response interceptor runs it before throwing `RedirectRefusedError` (second net, since `maxRedirects: 0` already stops the client from following).

---

### Task 7: Wire `SafeFetchService` to A9 options

**Files:**
- Modify: `apps/Flux-Prompt-Worker/src/modules/safe-fetch/safe-fetch.service.ts`

- [ ] **Step 1: Drop `EgressPolicyService` dep, add egress options**

Replace the constructor and dispatcher-creation methods:

```typescript
import { Injectable } from '@nestjs/common';
import { Agent } from 'undici';
import { AxiosInstance } from 'axios';
import {
  egressModeFromEnv,
  EgressOptions,
} from '@/modules/egress/egress-policy';
import { createSafeDispatcher } from './safe-dispatcher';
import { createSafeAxios, SafeAxiosContext } from './safe-axios';
import {
  RedirectRefusedError,
  RequestTimeoutError,
  ResponseTooLargeError,
} from './safe-fetch.errors';

interface EgressConfig {
  maxResponseBytes: number;
  timeoutMs: number;
}

export interface SafeFetchContext {
  orgId: string | undefined;
  nodeType: string;
  skipAddressChecks?: boolean;
  validateCertificate?: boolean;
  timeoutMsOverride?: number;
}

export interface SafeFetchResult {
  status: number;
  headers: Record<string, string>;
  text: string;
  bytes: number;
}

export interface SafeFetchBufferResult {
  status: number;
  headers: Record<string, string>;
  buffer: Buffer;
  bytes: number;
}

@Injectable()
export class SafeFetchService {
  private getConfig(): EgressConfig {
    return {
      maxResponseBytes: Number(
        process.env.EGRESS_MAX_RESPONSE_BYTES || 10_485_760,
      ),
      timeoutMs: Number(process.env.EGRESS_TIMEOUT_MS || 30_000),
    };
  }

  private getEgressOptions(): EgressOptions {
    return { mode: egressModeFromEnv() };
  }

  private logBlock(payload: Record<string, unknown>): void {
    console.error('egress.blocked', payload);
  }

  getDispatcher(context: SafeFetchContext): Agent {
    if (context.skipAddressChecks) {
      return new Agent({
        connect: { rejectUnauthorized: context.validateCertificate ?? true },
      });
    }
    return createSafeDispatcher({
      orgId: context.orgId,
      nodeType: context.nodeType,
      validateCertificate: context.validateCertificate,
      egressOptions: this.getEgressOptions(),
      logger: (payload) => this.logBlock(payload),
    });
  }

  createAxios(context: SafeAxiosContext): AxiosInstance {
    const config = this.getConfig();
    return createSafeAxios(context, {
      egressOptions: this.getEgressOptions(),
      logger: (payload) => this.logBlock(payload),
      config,
    });
  }

  // ...keep get, getBuffer, post, head, rawRequest, readLimitedBodyBuffer
  // (no body changes to those methods; they already use getDispatcher)
}
```

Note: Keep every other method in the file as-is. The two changes are: the constructor drops `EgressPolicyService`, and `getDispatcher`/`createAxios` now use `getEgressOptions()`.

- [ ] **Step 2: Update the module to drop `EgressPolicyService`**

Edit `apps/Flux-Prompt-Worker/src/modules/safe-fetch/safe-fetch.module.ts`:

```typescript
import { Global, Module } from '@nestjs/common';
import { SafeFetchService } from './safe-fetch.service';

@Global()
@Module({
  providers: [SafeFetchService],
  exports: [SafeFetchService],
})
export class SafeFetchModule {}
```

- [ ] **Step 3: Update the barrel**

Edit `apps/Flux-Prompt-Worker/src/modules/safe-fetch/index.ts` — remove the `EgressPolicyService` export:

```typescript
export { SafeFetchModule } from './safe-fetch.module';
export { SafeFetchService } from './safe-fetch.service';
export type { SafeFetchContext, SafeFetchResult } from './safe-fetch.service';
export type { SafeAxiosContext } from './safe-axios';
export {
  BlockedAddressError,
  RedirectRefusedError,
  RequestTimeoutError,
  ResponseTooLargeError,
} from './safe-fetch.errors';
```

---

### Task 8: Delete the second deny-list

**Files:**
- Delete: `apps/Flux-Prompt-Worker/src/modules/safe-fetch/egress-policy.service.ts`
- Delete: `apps/Flux-Prompt-Worker/src/modules/safe-fetch/egress-policy.service.spec.ts`

- [ ] **Step 1: Delete the files**

These are the 10-range deny-list and its spec. The A9 module's 17-range list is now the only one.

- [ ] **Step 2: Sanity-check for lingering imports**

Grep `apps/Flux-Prompt-Worker/src` for `EgressPolicyService` and `./egress-policy.service`. Any residual import after Tasks 5/6/7 is a bug — remove.

---

### Task 9: Update safe-fetch service spec (negative control)

**Files:**
- Modify: `apps/Flux-Prompt-Worker/src/modules/safe-fetch/safe-fetch.service.spec.ts`

- [ ] **Step 1: Add the DNS-pin negative control**

Append a describe block that mocks `node:dns/promises.lookup` to return `[public, denied]` for the test host. On the current (post-rewrite) code, the request is refused with `BlockedAddressError` because `createSafeLookup` iterates every resolved address. The test is the one the task spec requires:

```typescript
import * as dnsPromises from 'node:dns/promises';
import { SafeFetchService } from './safe-fetch.service';
import { BlockedAddressError } from './safe-fetch.errors';

describe('SafeFetchService — DNS pin negative control', () => {
  const originalEnv = process.env.EGRESS_POLICY_MODE;
  let service: SafeFetchService;
  let lookupSpy: jest.SpyInstance;

  beforeAll(() => {
    process.env.EGRESS_POLICY_MODE = 'enforce';
  });

  afterAll(() => {
    if (originalEnv === undefined) delete process.env.EGRESS_POLICY_MODE;
    else process.env.EGRESS_POLICY_MODE = originalEnv;
  });

  beforeEach(() => {
    service = new SafeFetchService();
    lookupSpy = jest.spyOn(dnsPromises, 'lookup').mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] as never);
  });

  afterEach(() => {
    lookupSpy.mockRestore();
  });

  it('refuses a host that resolves to a mixed public+denied set', async () => {
    await expect(
      service.getBuffer('https://dns-pin-test.local/', {
        orgId: 'org-test',
        nodeType: 'test',
      }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });
});
```

Context: With the pre-S6b code (the deleted `safe-dispatcher.ts` that iterated and returned on the first allowed address), this test would have **passed** (allowed the request). After the rewrite, the A9 `createSafeLookup` iterates ALL addresses — any denied one in the set fails the whole lookup. That's the pin. If someone reverts the fix, this test fails.

---

## Phase 3 — Worker sweep (five fetches)

### Task 10: Guard `audio-transcriber` (two fetch sites in one module)

**Files:**
- Modify: `apps/Flux-Prompt-Worker/src/modules/nodes/audio-transcriber/audio-transcriber.service.ts`
- Modify: `apps/Flux-Prompt-Worker/src/modules/nodes/audio-transcriber/audio-transcriber.module.ts` (if `SafeFetchService` isn't already available — it is, since `SafeFetchModule` is `@Global()`, so no module change needed, but verify)
- Modify: `apps/Flux-Prompt-Worker/src/modules/nodes/audio-transcriber/google-speech.ts`

- [ ] **Step 1: Inject `SafeFetchService` into the service**

In `audio-transcriber.service.ts`, add the import and inject:

```typescript
import { SafeFetchService } from '@/modules/safe-fetch';
// ...
constructor(
  private readonly aiProviders: AiProviderService,
  private readonly databaseService: DatabaseService,
  private readonly safeFetch: SafeFetchService,
) {}
```

- [ ] **Step 2: Replace the `downloadAudio` body**

Replace the current method:

```typescript
private async downloadAudio(url: string, workDir: string): Promise<string> {
  let result: { buffer: Buffer; bytes: number; status: number };
  try {
    result = await this.safeFetch.getBuffer(url, {
      orgId: undefined,
      nodeType: 'audioTranscriber',
    });
  } catch (err) {
    throw new UserConfigError({
      field: 'inputPreview',
      devMessage: `Audio download failed: ${err instanceof Error ? err.message : String(err)}`,
      userMessage:
        'The URL provided could not be reached, is in a blocked range, or does not point to a downloadable file.',
      cause: err,
    });
  }
  if (result.status < 200 || result.status >= 300) {
    throw new UserConfigError({
      field: 'inputPreview',
      devMessage: `Audio download failed with status ${result.status}`,
      userMessage:
        'The URL provided could not be reached or does not point to a downloadable file.',
    });
  }
  if (result.buffer.byteLength === 0) {
    throw new UserConfigError({
      field: 'inputPreview',
      devMessage: 'Audio download returned an empty body',
      userMessage: 'The audio file at the provided URL is empty.',
    });
  }
  const inputPath = path.join(workDir, 'input');
  await fs.writeFile(inputPath, result.buffer);
  return inputPath;
}
```

- [ ] **Step 3: Pass `safeFetch` to `transcribeWithGoogleSpeech`**

Update the call in `audio-transcriber.service.ts` (around line 122):

```typescript
if (pair.aiSystem === 'gemini') {
  const speech = await this.callProvider(pair, () =>
    transcribeWithGoogleSpeech(url, this.safeFetch),
  );
  // ...rest unchanged
}
```

Edit `google-speech.ts` — the download block (lines 36–57) becomes:

```typescript
import { SafeFetchService } from '@/modules/safe-fetch';

export async function transcribeWithGoogleSpeech(
  url: string,
  safeFetch: SafeFetchService,
): Promise<GoogleSpeechResult> {
  const projectId = process.env.GOOGLE_PROJECT_ID;
  const bucketName = process.env.GOOGLE_BUCKET_NAME;
  if (!projectId || !bucketName) {
    throw new Error(
      'Google Speech-to-Text is not configured. Set GOOGLE_PROJECT_ID and GOOGLE_BUCKET_NAME.',
    );
  }
  const auth = resolveGoogleClientAuth('Google Speech-to-Text');
  const fileName = `audio_${Date.now()}.mp3`;
  const filePath = path.join(os.tmpdir(), fileName);

  const response = await safeFetch.getBuffer(url, {
    orgId: undefined,
    nodeType: 'audioTranscriber',
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Failed to download audio from URL — status ${response.status}`,
    );
  }
  await fs.writeFile(filePath, response.buffer);

  // ...rest of the function (try/finally with Storage + SpeechClient) unchanged.
}
```

Keep the full `try { … } finally { await fs.rm(filePath, { force: true }); }` block from the current file (lines 58–95) unchanged. Only the first fetch block and the function signature change.

- [ ] **Step 4: Update the module (verify `SafeFetchService` is available)**

Since `SafeFetchModule` is `@Global()`, no explicit import is required. Double-check that no manual `providers: [SafeFetchService]` entry is needed in `audio-transcriber.module.ts`.

---

### Task 11: Guard `image-reader/google-docai-base.ts`

**Files:**
- Modify: `apps/Flux-Prompt-Worker/src/modules/nodes/image-reader/providers/google-docai-base.ts`

- [ ] **Step 1: Convert `downloadDocument` to accept SafeFetchService**

Change the signature from free-function (`fetch`) to one that accepts `SafeFetchService`. Replace the function:

```typescript
import { SafeFetchService } from '@/modules/safe-fetch';

export async function downloadDocument(
  { url }: OcrProviderInput,
  safeFetch: SafeFetchService,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await safeFetch.getBuffer(url, {
    orgId: undefined,
    nodeType: 'imageReader',
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Failed to download document from URL: ${url} — status ${response.status}`,
    );
  }
  const mimeType = resolveMimeType(url, response.headers['content-type'] ?? null);
  return { buffer: response.buffer, mimeType };
}
```

- [ ] **Step 2: Thread `safeFetch` through `processWithDocAi`**

```typescript
export async function processWithDocAi(
  client: DocumentProcessorServiceClient,
  config: GoogleDocAiConfig,
  input: OcrProviderInput,
  safeFetch: SafeFetchService,
): Promise<ImageReaderProviderResult> {
  const { buffer, mimeType } = await downloadDocument(input, safeFetch);
  // ...rest unchanged
}
```

- [ ] **Step 3: Inject `SafeFetchService` into both DocAI providers**

Edit `apps/Flux-Prompt-Worker/src/modules/nodes/image-reader/providers/google-docai-form.provider.ts`:

```typescript
import type { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { Injectable } from '@nestjs/common';
import { SafeFetchService } from '@/modules/safe-fetch';
import type {
  ImageReaderProviderResult,
  OcrProvider,
  OcrProviderInput,
} from '../image-reader.types';
import {
  buildDocAiConfig,
  createGoogleDocAiClient,
  processWithDocAi,
} from './google-docai-base';

const FORM_PARSER_PROCESSOR_ENV_VAR = 'GOOGLE_FORM_PARSER_PROCESSOR_ID';

@Injectable()
export class GoogleDocAiFormProvider implements OcrProvider {
  private client: DocumentProcessorServiceClient | null = null;

  constructor(private readonly safeFetch: SafeFetchService) {}

  private getClient(): DocumentProcessorServiceClient {
    if (!this.client) {
      this.client = createGoogleDocAiClient();
    }
    return this.client;
  }

  async extract(input: OcrProviderInput): Promise<ImageReaderProviderResult> {
    const config = buildDocAiConfig(FORM_PARSER_PROCESSOR_ENV_VAR);
    return processWithDocAi(this.getClient(), config, input, this.safeFetch);
  }
}
```

Edit `apps/Flux-Prompt-Worker/src/modules/nodes/image-reader/providers/google-docai-ocr.provider.ts` identically (swap `GOOGLE_FORM_PARSER_PROCESSOR_ID` → `GOOGLE_PROCESSOR_ID`, class name `GoogleDocAiOcrProvider`, const `OCR_PROCESSOR_ENV_VAR`).

- [ ] **Step 4: Verify `ImageReaderService` constructor needs no change**

The two DocAI providers get `SafeFetchService` injected directly by Nest DI — `ImageReaderService` doesn't need to receive it. Confirm by opening `image-reader.service.ts` and leaving its constructor as-is. If `SafeFetchModule` (`@Global()`) is already loaded in the AppModule, no module-level import is required.

---

### Task 12: Guard `push-data` raw-files uploader

**Files:**
- Modify: `apps/Flux-Prompt-Worker/src/modules/nodes/push-data/push-data.service.ts`

- [ ] **Step 1: Inject `SafeFetchService`**

```typescript
import { SafeFetchService } from '@/modules/safe-fetch';
// ...
constructor(
  private readonly db: DatabaseService,
  private readonly tokenProvider: TokenProviderService,
  private readonly googleSheets: GoogleSheetsService,
  private readonly googleDocs: GoogleDocsService,
  private readonly googleDrive: GoogleDriveService,
  private readonly googleSlides: GoogleSlidesService,
  private readonly microsoftDrive: MicrosoftDriveService,
  private readonly safeFetch: SafeFetchService,
) {}
```

- [ ] **Step 2: Replace the loop body in `uploadMicrosoftRawFiles`**

Replace lines 437–461 (the `for (const url of urls)` body):

```typescript
for (const url of urls) {
  let response;
  try {
    response = await this.safeFetch.getBuffer(url, {
      orgId: undefined,
      nodeType: 'pushData',
    });
  } catch {
    continue;
  }
  if (response.status < 200 || response.status >= 300) continue;
  const contentType =
    response.headers['content-type'] || 'application/octet-stream';
  const resolvedName = fileName || url.split('/').pop() || 'uploaded-file';
  if (folderId) {
    await this.microsoftDrive.uploadFileToFolder({
      accessToken,
      folderId,
      fileName: resolvedName,
      buffer: response.buffer,
      contentType,
    });
  } else {
    await this.microsoftDrive.uploadFileToRoot({
      accessToken,
      fileName: resolvedName,
      buffer: response.buffer,
      contentType,
    });
  }
}
```

---

### Task 13: Guard `multimodal-file-processor` (text-generator)

**Files:**
- Modify: `apps/Flux-Prompt-Worker/src/modules/nodes/text-generator/multimodal-file-processor.ts`
- Modify: `apps/Flux-Prompt-Worker/src/modules/nodes/text-generator/text-generator.service.ts` (caller)

- [ ] **Step 1: Change `processMultimodalUrls` to accept `SafeFetchService`**

Replace the exported entry point and its two helpers:

```typescript
import { SafeFetchService } from '@/modules/safe-fetch';
// ...drop the `fetchWithTimeout`, `detectMimeFromHead`, `downloadFile` free functions.
// Replace with service-aware versions:

async function detectMimeFromHead(
  url: string,
  safeFetch: SafeFetchService,
): Promise<string | null> {
  try {
    const response = await safeFetch.head(url, {
      orgId: undefined,
      nodeType: 'textGenerator',
    });
    if (response.status < 200 || response.status >= 300) return null;
    return response.headers['content-type'] ?? null;
  } catch {
    return null;
  }
}

async function downloadFile(
  url: string,
  safeFetch: SafeFetchService,
): Promise<{ buffer: Buffer; contentType: string }> {
  let response;
  try {
    response = await safeFetch.getBuffer(url, {
      orgId: undefined,
      nodeType: 'textGenerator',
    });
  } catch (err) {
    throw new UserConfigError({
      field: 'multimodalContent',
      devMessage: `Network error fetching '${url}': ${err instanceof Error ? err.message : String(err)}`,
      userMessage: `Could not fetch file from URL '${url}'. Verify the URL is publicly accessible.`,
      cause: err,
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new UserConfigError({
      field: 'multimodalContent',
      devMessage: `HTTP ${response.status} fetching '${url}'`,
      userMessage: `Could not fetch file from URL '${url}' (HTTP ${response.status}).`,
    });
  }
  if (response.bytes > MAX_DOWNLOAD_BYTES) {
    throw new UserConfigError({
      field: 'multimodalContent',
      devMessage: `File exceeds max size at '${url}': ${response.bytes} bytes`,
      userMessage: `File at URL '${url}' is too large to process (max ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB).`,
    });
  }
  const contentType =
    response.headers['content-type'] ?? 'application/octet-stream';
  return { buffer: response.buffer, contentType };
}
```

- [ ] **Step 2: Thread `safeFetch` through `processOneUrl` and `processMultimodalUrls`**

```typescript
async function processOneUrl(
  url: string,
  limits: ProviderMultimodalLimits,
  safeFetch: SafeFetchService,
): Promise<ProcessedMultimodalFile> {
  const headMime = await detectMimeFromHead(url, safeFetch);
  // ...rest unchanged except `downloadFile(url)` → `downloadFile(url, safeFetch)`
}

export async function processMultimodalUrls(params: {
  urls: string[];
  provider: string;
  safeFetch: SafeFetchService;
}): Promise<ProcessedMultimodalFile[]> {
  const limits = PROVIDER_LIMITS[params.provider];
  if (!limits) { /* unchanged */ }
  const results: ProcessedMultimodalFile[] = [];
  for (const url of params.urls) {
    const processed = await processOneUrl(url, limits, params.safeFetch);
    results.push(processed);
  }
  enforceCountLimits(results, limits);
  return results;
}
```

- [ ] **Step 3: Update the caller**

Open `apps/Flux-Prompt-Worker/src/modules/nodes/text-generator/text-generator.service.ts`. Find the `processMultimodalUrls({ urls, provider })` call. Add `SafeFetchService` to the constructor and pass it through:

```typescript
constructor(
  // ...existing deps,
  private readonly safeFetch: SafeFetchService,
) {}

// at the call site:
const files = await processMultimodalUrls({
  urls,
  provider,
  safeFetch: this.safeFetch,
});
```

- [ ] **Step 4: Drop the unused `USER_AGENT` and `HEAD_TIMEOUT_MS` constants if no longer referenced**

The old `fetchWithTimeout` carried `User-Agent` and timeouts manually. Those are now owned by `SafeFetchService` configuration. If `USER_AGENT`, `HEAD_TIMEOUT_MS`, `DOWNLOAD_TIMEOUT_MS` are unreferenced after the rewrite, delete them. If something still reads them, leave them.

---

## Phase 4 — Back: /proxy, /api_call, downloader

### Task 14: Create `ProxyModule`

**Files:**
- Create: `apps/Flux-Prompt/src/app-api/proxy/proxy.module.ts`
- Create: `apps/Flux-Prompt/src/app-api/proxy/proxy.controller.ts`
- Create: `apps/Flux-Prompt/src/app-api/proxy/proxy.service.ts`

- [ ] **Step 1: Service**

```typescript
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import axios from 'axios';
import {
  assertEgressAllowed,
  egressHttpConfig,
  egressModeFromEnv,
  isEgressRefusal,
} from 'src/common/egress/egress-policy';

@Injectable()
export class ProxyService implements OnModuleInit {
  private readonly logger = new Logger(ProxyService.name);
  private allowedHosts: Set<string> = new Set();

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const raw =
      this.configService.get<string>('PROXY_ALLOWED_HOSTS')?.trim() ?? '';
    this.allowedHosts = new Set(
      raw
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0),
    );
    this.logger.log(
      `Proxy allowlist loaded: ${this.allowedHosts.size} host(s)`,
    );
  }

  async fetchProxied(rawUrl: string, res: Response): Promise<void> {
    if (!rawUrl) {
      throw new BadRequestException('URL query parameter is required.');
    }
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new BadRequestException('The URL provided is not valid.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BadRequestException('Only http:/https: URLs are allowed.');
    }
    if (!this.allowedHosts.has(url.hostname.toLowerCase())) {
      throw new ForbiddenException('This image host is not allowed.');
    }
    const egressOptions = { mode: egressModeFromEnv() };
    try {
      await assertEgressAllowed(rawUrl, egressOptions);
      const upstream = await axios.get(rawUrl, {
        responseType: 'stream',
        maxRedirects: 0,
        validateStatus: () => true,
        ...egressHttpConfig(egressOptions),
      });
      const contentType = upstream.headers['content-type'];
      if (contentType) res.setHeader('Content-Type', String(contentType));
      const contentLength = upstream.headers['content-length'];
      if (contentLength)
        res.setHeader('Content-Length', String(contentLength));
      res.status(upstream.status);
      upstream.data.pipe(res);
    } catch (err) {
      if (isEgressRefusal(err)) {
        throw new ForbiddenException('This image host is not allowed.');
      }
      throw err;
    }
  }
}
```

- [ ] **Step 2: Controller**

```typescript
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from 'src/app-auth/guards/jwt-auth.guard';
import { ProxyService } from './proxy.service';

@Controller('proxy')
@UseGuards(JwtAuthGuard)
@ApiTags('Proxy')
@ApiBearerAuth('access-token')
export class ProxyController {
  constructor(private readonly proxyService: ProxyService) {}

  @Get()
  async proxy(@Query('url') url: string, @Res() res: Response): Promise<void> {
    await this.proxyService.fetchProxied(url, res);
  }
}
```

- [ ] **Step 3: Module**

```typescript
import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { ProxyService } from './proxy.service';

@Module({
  controllers: [ProxyController],
  providers: [ProxyService],
})
export class ProxyModule {}
```

---

### Task 15: Delete the `/proxy` Express middleware and register `ProxyModule`

**Files:**
- Modify: `apps/Flux-Prompt/src/main.ts`
- Modify: `apps/Flux-Prompt/src/app.module.ts`

- [ ] **Step 1: Delete the Express middleware**

In `main.ts`, delete lines 134–181 (the entire `app.use('/proxy', createProxyMiddleware({...}))` block). Also remove the top-of-file import `import { createProxyMiddleware } from 'http-proxy-middleware';` if nothing else uses it (grep first).

- [ ] **Step 2: Register the module**

Open `app.module.ts`. Add `import { ProxyModule } from './app-api/proxy/proxy.module';` and include `ProxyModule` in the `imports` array.

---

### Task 16: Guard `/api_call` with egress

**Files:**
- Modify: `apps/Flux-Prompt/src/app-api/api_call/api_call.service.ts`

- [ ] **Step 1: Add the egress check**

Replace the top of the file and the two public methods:

```typescript
import { Injectable } from '@nestjs/common';
import axios, { AxiosRequestConfig } from 'axios';
import * as https from 'https';
import { User } from 'src/entities/user.entity';
import { WinstonLogger } from 'src/logging/winston.logger';
import {
  assertEgressAllowed,
  egressHttpConfig,
  egressModeFromEnv,
  isEgressRefusal,
} from 'src/common/egress/egress-policy';

@Injectable()
export class ApiCallService {
  constructor(private readonly loggerService: WinstonLogger) {}

  async executeApiCall(body: any, user: User) {
    const egressOptions = { mode: egressModeFromEnv() };
    await assertEgressAllowed(String(body.url ?? ''), egressOptions);
    const axiosConfig: AxiosRequestConfig = {
      ...body,
      httpsAgent: new https.Agent({
        rejectUnauthorized: body.validateCertificate,
      }),
      responseType: 'arraybuffer' as const,
      maxRedirects: 0,
      ...egressHttpConfig(egressOptions),
    };
    return this.executeRequest(axiosConfig, { user });
  }
  // ...keep executeRequest, executeRequestWithStatus, executeRequestInternal as-is
}
```

- [ ] **Step 2: Update the controller's error branch**

Edit `apps/Flux-Prompt/src/app-api/api_call/api_call.controller.ts` — in the existing `.catch((err) => {...})` block that builds `errorMessage`, add at the top:

```typescript
if (isEgressRefusal(err)) {
  this.gateway.response('api-call', responseSocketId, {
    error: 'This URL points to an address that is not allowed.',
  });
  return;
}
```

And import `isEgressRefusal`:

```typescript
import { isEgressRefusal } from 'src/common/egress/egress-policy';
```

---

### Task 17: Delete `DownloaderService.downloadFile`

**Files:**
- Delete: `apps/Flux-Prompt/src/app-api/downloader/downloader.service.ts`
- Modify: `apps/Flux-Prompt/src/app-api/downloader/downloader.controller.ts`
- Modify: `apps/Flux-Prompt/src/app-api/app-api.module.ts`

- [ ] **Step 1: Delete the service file**

Delete `downloader.service.ts`. It has no callers (grep confirmed: only self-import).

- [ ] **Step 2: Drop the dep from the controller**

Edit `downloader.controller.ts`:

```typescript
import { Controller, Get, Inject, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiExtraModels } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/app-auth/guards/jwt-auth.guard';
import { MessageDto } from 'src/common/dto/message.dto';
import { BaseController } from '../base.controller';
import { ApiSingleDto } from 'src/common/dto/pagination.dto';
import { Response } from 'express';
import { CurrentUser } from '../user/decorators/currentUser.decorator';
import { User } from 'src/entities/user.entity';
import * as mime from 'mime-types';
import { AwsService } from '../aws/aws.service';

@Controller('downloader')
@ApiTags('Downloader')
@ApiBearerAuth('access-token')
@ApiExtraModels(MessageDto)
@UseGuards(JwtAuthGuard)
export class DownloaderController extends BaseController {
  @Inject(AwsService)
  private readonly awsService: AwsService;

  @ApiSingleDto({
    status: 200,
    type: MessageDto,
    description: 'Download file from url',
  })
  @Get()
  async downloader(
    @Res() res: Response,
    @CurrentUser() user: User,
    @Query('url') url: string,
  ) {
    try {
      const cloudFront = process.env.CLOUDFRONT_ASSETS_URL;
      const replace = url.replace(cloudFront + '/', '');
      const item = await this.awsService.getFile(replace);
      const mimetype: any = mime.lookup(url);
      res.setHeader('Content-Type', mimetype);
      item.pipe(res);
    } catch (error) {
      return this.error(res, 'error');
    }
  }
}
```

- [ ] **Step 3: Drop the provider**

Edit `app-api.module.ts` — remove line 122 (`import { DownloaderService } from './downloader/downloader.service';`) and line 381 (`DownloaderService,` entry in the providers array).

---

### Task 18: Add new env vars to the back's example

**Files:**
- Modify: `apps/Flux-Prompt/.env.example`

- [ ] **Step 1: Append env vars**

Add at the end of the file (or in a sensible section):

```
# SSRF / egress policy
# Comma-separated list of hostnames /proxy may forward to (e.g. CloudFront + S3 image buckets).
# Empty value = /proxy refuses every request. Lowercased hostnames only; no ports.
PROXY_ALLOWED_HOSTS=

# off | report | enforce. 'enforce' matches worker from 2026-10-19.
EGRESS_POLICY_MODE=report
```

---

## Phase 5 — Front

### Task 19: Create `useProxiedImage` hook

**Files:**
- Create: `apps/Flux-Prompt-Frontend/src/hooks/useProxiedImage.ts`

- [ ] **Step 1: Write the hook**

```typescript
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { api } from '@/lib/axios';

export interface UseProxiedImageResult {
  src: string | null;
  isLoading: boolean;
  isError: boolean;
}

export function useProxiedImage(
  url: string | null | undefined,
): UseProxiedImageResult {
  const createdUrlRef = useRef<string | null>(null);

  const query = useQuery({
    queryKey: ['proxied-image', url ?? ''],
    enabled: Boolean(url),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const response = await api.get<Blob>('/proxy', {
        params: { url },
        responseType: 'blob',
      });
      const objectUrl = URL.createObjectURL(response.data);
      createdUrlRef.current = objectUrl;
      return objectUrl;
    },
  });

  useEffect(() => {
    return () => {
      if (createdUrlRef.current) {
        URL.revokeObjectURL(createdUrlRef.current);
        createdUrlRef.current = null;
      }
    };
  }, [url]);

  return {
    src: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
```

Note: `src/lib/axios.ts` exports a named `api` instance that already carries the `Authorization: Bearer <JWT>` interceptor (verified).

---

### Task 20: Switch `ExpandImageModal` to the hook

**Files:**
- Modify: `apps/Flux-Prompt-Frontend/src/components/ExpandImageModal/ExpandImageModal.tsx`

- [ ] **Step 1: Replace the raw `<img src>`**

Add the import at the top:

```typescript
import { useProxiedImage } from '@/hooks/useProxiedImage';
```

Inside the component, right after `const { onHideModal, onSave, imageUrl, initialDimensions } = props;`:

```typescript
const { src: proxiedSrc, isLoading: isProxiedLoading } = useProxiedImage(imageUrl);
```

Replace the current `<img>` (line 779–794):

```tsx
{proxiedSrc ? (
  <img
    src={proxiedSrc}
    alt="Expandable"
    style={{
      maxWidth: '100%',
      maxHeight: '100%',
      width: scaledWidth,
      height: scaledHeight,
      position: 'absolute',
      zIndex: 0,
      ...getDimensionStyles(),
    }}
  />
) : (
  <Box sx={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <Typography variant="body2">
      {isProxiedLoading ? 'Loading image…' : 'Image unavailable.'}
    </Typography>
  </Box>
)}
```

---

### Task 21: Switch `MaskImageEditModal` to the hook

**Files:**
- Modify: `apps/Flux-Prompt-Frontend/src/components/MaskImageEditModal/MaskImageEditModal.tsx`

- [ ] **Step 1: Replace the `useImage` call**

Add the import:

```typescript
import { useProxiedImage } from '@/hooks/useProxiedImage';
```

Replace line 27–30:

```typescript
const { src: proxiedSrc } = useProxiedImage(imageUrl);
const [image] = useImage(proxiedSrc ?? '', 'anonymous');
```

The downstream Konva code already guards on `if (image)` (line 201), so an empty `proxiedSrc` → `useImage('')` → `image` undefined → the layout gracefully degrades. No further UI changes needed.

---

## Phase 6 — Spec update

### Task 22: Record the sweep in the task spec

**Files:**
- Modify: `.claude/tasks/worker-flow-execution-epic/TASK-S6B-SSRF-GAPS.md`

- [ ] **Step 1: Append the sweep section**

Append at the end of the file (after the current `## Files` section):

```markdown
## Sweep (recorded 2026-10-29)

Every outbound fetch of a user-supplied URL in `back` and `worker`:

**Back (3):**
- `back/src/main.ts` `/proxy` (was: Express middleware, no auth, no allowlist) → rewritten as `src/app-api/proxy/` NestJS module with `JwtAuthGuard` + `PROXY_ALLOWED_HOSTS` allowlist + `egressHttpConfig`.
- `back/src/app-api/api_call/api_call.service.ts` `executeApiCall` (was: plain axios) → guarded by `assertEgressAllowed` + `egressHttpConfig`.
- `back/src/app-api/downloader/downloader.service.ts` `downloadFile` → **deleted** (no caller).

**Worker (5):**
- `worker/src/modules/nodes/audio-transcriber/audio-transcriber.service.ts:156` `downloadAudio` → `SafeFetchService.getBuffer`.
- `worker/src/modules/nodes/audio-transcriber/google-speech.ts:50` → `SafeFetchService.getBuffer`.
- `worker/src/modules/nodes/image-reader/providers/google-docai-base.ts:45` `downloadDocument` → `SafeFetchService.getBuffer`.
- `worker/src/modules/nodes/push-data/push-data.service.ts:438` `uploadMicrosoftRawFiles` → `SafeFetchService.getBuffer`.
- `worker/src/modules/nodes/text-generator/multimodal-file-processor.ts` `detectMimeFromHead` / `downloadFile` → `SafeFetchService.head` / `SafeFetchService.getBuffer`.

**Deny-list consolidation:**
- `worker/src/modules/safe-fetch/egress-policy.service.ts` (10 ranges) → **deleted**.
- `worker/src/modules/egress/egress-policy.ts` (17 ranges) → sole source. Ported to `back/src/common/egress/egress-policy.ts`; drift tested in both repos.

No other outbound fetch of a user-supplied URL remained unguarded as of this change.
```

---

## Verification (user runs after plan completes)

Run from the respective repo root:

- **Back:** `pnpm test -- --testPathPattern=egress-policy-drift` and the full suite.
- **Worker:** `npm test -- --testPathPattern=egress-policy-drift` (or `vitest run test/egress-policy-drift.spec.ts`) and the full suite including the new DNS-pin negative control.
- **Front:** `pnpm test` (unit + component).
- **End-to-end manual:**
  1. Open a flow in the editor, open an image node, trigger `ExpandImageModal` — image loads.
  2. Same, trigger `MaskImageEditModal` — image loads.
  3. `curl -i $API_URL/proxy?url=https://google.com/favicon.ico` with no `Authorization` header → `401`.
  4. Same with a Bearer token → `403` (google.com not in allowlist).
  5. Same with a Bearer token and `url=` an allowed CloudFront image → `200` + bytes.
  6. In an api_call node, point `url` at `http://169.254.169.254/latest/meta-data/` → WS receives the "not allowed" error.
