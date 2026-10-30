# S6b — SSRF gap closure (design)

**Date:** 2026-10-29 · **ClickUp:** [868mn5gb5](https://app.clickup.com/t/868mn5gb5) · **Task:** `.claude/tasks/worker-flow-execution-epic/TASK-S6B-SSRF-GAPS.md`

## Goal

No FluxPrompt endpoint or node reaches an internal address through a URL a user supplies, whatever that URL's name resolves to.

## Scope and non-goals

**In.** Four gaps the S6-a code check found, plus the sweep the spec names:

1. Back `/proxy` route (`src/main.ts`) — unauth, no host check, forwards anywhere.
2. Worker `safe-fetch` dispatcher — passes a host when any resolved address is allowed, then re-resolves by hostname (TOCTOU).
3. Two deny-lists in the worker (10 ranges in safe-fetch, 17 in the A9 `egress` module).
4. Back `POST /api_call` — plain `axios`, no egress check; `DownloaderService.downloadFile` with no caller.
5. Three (actually five, found by this design's sweep) raw `fetch(url)` call sites in the worker that accept user URLs.

**Out.** A per-organisation allowlist (S6-a's option A). Report-only / dark-launch of the `/proxy` allowlist — the user accepts going straight to enforce.

## Decisions recorded during brainstorming

| # | Decision | Reason |
|---|---|---|
| D1 | `/proxy` auth = **fetch with Bearer header + Blob URL in the front**, not query-string token. | Keeps the JWT out of URL/log/HAR, consistent with the rest of the API. The two consumers (`ExpandImageModal`, `MaskImageEditModal`) are the only call sites and both can switch to a blob-based `<img src>` / `useImage`. |
| D2 | `/proxy` allowlist source = **new `PROXY_ALLOWED_HOSTS` env var** (comma-separated). Empty = refuse all. | Explicit per environment, no coupling to `CLOUDFRONT_ASSETS_URL`, follows the spec rule "read the list from configuration, not from the request." |
| D3 | Back gets its **own copy** of `egress-policy.ts` + a drift test. | Two repos, one behaviour. A shared package would mean new release infra; delegating back to worker would couple `/proxy` to Temporal. The drift test (mirrored in both repos) turns divergence into a CI failure. |
| D4 | Sweep guards **all 5** raw-fetch sites (3 named in the spec + `multimodal-file-processor` + `audio-transcriber/google-speech`). | The spec says "no other outbound fetch of a user-supplied URL is left unguarded." All five receive URLs that originate in node data. |
| D5 | **No dark-launch, no report-only phase** for `/proxy`. Ship with enforce from the merge, accept a possible hotfix if a legitimate host was passing through unseen. | The user chose to accept the risk. The two known front consumers only load images from our CloudFront + S3 buckets; the chance of an outside host is low. |

## Architecture

### Three repos, no PR split

The user chose to ship this as a single workstream (no sub-PRs). The implementation touches three repos — `back/`, `worker/`, `front/` — but is logically one change. Branches, commits, and PR creation stay with the user.

### Component A — Back `/proxy` (and the two front modals)

**Delete** the `app.use('/proxy', createProxyMiddleware(...))` block in `back/src/main.ts` (lines 134–181 today). It runs before every Nest guard and has no auth, no allowlist, and a `fallback` origin that silently resolves to `https://api-dev.fluxprompt.ai` on error.

**Add** a NestJS module `back/src/app-api/proxy/`:

```
proxy/
├── proxy.module.ts
├── proxy.controller.ts
└── proxy.service.ts
```

- `ProxyController` — `@Controller('proxy')` + `@UseGuards(JwtAuthGuard)`. Single `@Get()` with `@Query('url') url: string`.
- `ProxyService.fetchProxied(url, res)`:
  - Parse `url` with `new URL(url)` → `BadRequestException` on throw.
  - Reject non-`http:`/`https:` protocols with `BadRequestException`.
  - Compare `url.hostname` (WHATWG URL guarantees lowercase) against the frozen `Set<string>` loaded from `PROXY_ALLOWED_HOSTS` at boot (also lowercased). Not in set → `ForbiddenException`.
  - `axios.get(url, { responseType: 'stream', ...egressHttpConfig(opts), maxRedirects: 0 })` using the back-side egress port described in Component D (pin + redirect guard — belt and suspenders on top of the allowlist).
  - Copy `content-type` and `content-length` from the upstream response, then `response.data.pipe(res)`.
- `ProxyModule` provides `ProxyService` and reads `PROXY_ALLOWED_HOSTS` from `ConfigService` on `onModuleInit`, logging the loaded list once at startup.

**Register** `ProxyModule` in `app.module.ts`.

**Front — new hook** `front/src/hooks/useProxiedImage.ts`:
- Takes a `url: string | null | undefined`.
- Uses `useQuery` (TanStack Query — follows `.claude/rules/react-query.md`) with `queryKey: ['proxied-image', url]`, `queryFn` calling `axios.get('/proxy', { params: { url }, responseType: 'blob' })` and returning `URL.createObjectURL(data)`.
- `onSettled` / `useEffect` cleanup calls `URL.revokeObjectURL`.
- Returns `{ src: string | null, isLoading, isError }`.
- `enabled: Boolean(url)`.

**Front — modal changes**:
- `ExpandImageModal.tsx` line 780: `<img src={`${import.meta.env.VITE_API_URL}/proxy?url=${imageUrl}`} />` → `const { src } = useProxiedImage(imageUrl); return src ? <img src={src} /> : <Spinner />;`.
- `MaskImageEditModal.tsx` line 27: `useImage(`${import.meta.env.VITE_API_URL}/proxy?url=${imageUrl}`, 'anonymous')` → `const { src } = useProxiedImage(imageUrl); const [image] = useImage(src ?? '', 'anonymous');`.

**Error UX**: 401 is already handled by the global axios interceptor (logs the user out). 403 shows a toast "This image host is not allowed."

### Component B — Worker: safe-fetch rebuilt on A9 egress

**Delete** `worker/src/modules/safe-fetch/egress-policy.service.ts` entirely. The 10-range `DENIED_CIDRS` list, `CidrRange`, `parseCidr`, `matchCidr`, `ipv4ToBigInt`, `ipv6ToBigInt`, `expandIpv6`, `EgressPolicyService` — all gone. The 17-range list in `worker/src/modules/egress/egress-policy.ts` is the only remaining deny-list.

**Rewrite** `worker/src/modules/safe-fetch/safe-dispatcher.ts`:
- `createSafeDispatcher` no longer takes a `policy: EgressPolicyService`. It takes `egressOptions: EgressOptions` from the A9 module.
- `connect`: calls `assertEgressAllowed(url, egressOptions)` once before building the connection; the `undici.Agent` uses the default connector (no custom DNS loop); the redirect guard is applied by the fetch call at `safe-fetch.service.ts`.
- Preserves the public API shape so `apiCaller` and `fileSave` need no change beyond their constructor wiring.

**Rewrite** `worker/src/modules/safe-fetch/safe-axios.ts`:
- `createSafeAxios` uses `egressHttpConfig(egressOptions)` → `{ proxy: false, lookup: createSafeLookup(opts), beforeRedirect: createRedirectGuard(opts) }`.
- `httpsAgent: new https.Agent({ lookup: createSafeLookup(opts) })`.
- `maxRedirects: 0` stays — the "refuse all redirects" policy is a safe-fetch property, not an A9 property. `createRedirectGuard` is the second net.
- `buildCheckingLookup` is deleted (duplicates `createSafeLookup`).

**Keep** `SafeFetchService` public surface (`get`, `getBuffer`, `post`, `createAxios`, `getDispatcher`) and **add** `head(url, ctx)` for the multimodal pre-flight MIME check. Internally it now wires `createSafeDispatcher`/`createSafeAxios` with `egressOptions: { mode: egressModeFromEnv(), allow: undefined }`.

**Keep** `BlockedAddressError`, `RedirectRefusedError`, `RequestTimeoutError`, `ResponseTooLargeError` as the public exceptions. Map the A9 `UserConfigError` with `code === EGRESS_REFUSED_CODE` into `BlockedAddressError` so callers see a stable error shape.

**Delete** the `safe-fetch` deny-list spec and update the service spec to assert against the A9 module's behaviour.

### Component C — Worker: sweep of raw `fetch(url)` call sites

Five raw-fetch call sites receive user URLs today. Each one is replaced with `SafeFetchService` injected into the module.

| File | Call | After |
|---|---|---|
| `nodes/audio-transcriber/audio-transcriber.service.ts:156` | `fetch(url).catch(...)` inside `downloadAudio` | `safeFetch.getBuffer(url, { nodeType: 'audioTranscriber', orgId })` → the same `UserConfigError` on failure, plus `BlockedAddressError` propagation. |
| `nodes/audio-transcriber/google-speech.ts:50` | `fetch(url)` | Same. The function already takes a `url` param — change it to take a `SafeFetchService` reference. |
| `nodes/image-reader/providers/google-docai-base.ts:45` | `fetch(url)` inside `downloadDocument` | Same. `downloadDocument` becomes a service method rather than a free function so it can be injected. |
| `nodes/push-data/push-data.service.ts:438` | `fetch(url)` inside `uploadMicrosoftRawFiles` | Same, inside the already-injectable `PushDataService`. |
| `nodes/text-generator/multimodal-file-processor.ts:131–192` | `fetchWithTimeout` + `downloadFile` + `detectMimeFromHead` | All three use raw `fetch`. Replace with `safeFetch.get` / `safeFetch.getBuffer` / **new** `safeFetch.head(url, ctx)`. `AbortSignal.timeout` moves into the SafeFetch call. HEAD stays — it is the pre-flight MIME check that lets us refuse an unsupported file before downloading the whole body. |

Each site today has its own `UserConfigError` with `userMessage`/`devMessage`. Preserve those messages; add a top-level catch for `BlockedAddressError` / `RedirectRefusedError` → `UserConfigError({ userMessage: "This URL points to an address that is not allowed.", devMessage: `egress refused: ${err.deniedRange}` })`.

### Component D — Back: port A9 egress, guard `/api_call`, delete DownloaderService.downloadFile

**Port** `worker/src/modules/egress/egress-policy.ts` → `back/src/common/egress/egress-policy.ts`. The copy is **byte-identical** except for the import of the error types: the back has no `node-error` module, so refusal throws `BadRequestException`/`InternalServerErrorException` from `@nestjs/common` directly, carrying the same `userMessage` text.

Exported surface (identical names):
- `assertEgressAllowed(url, options)`
- `createSafeLookup(options)`
- `createRedirectGuard(options)`
- `egressHttpConfig(options)` → `{ proxy: false, lookup, beforeRedirect }`
- `isEgressRefusal(err)`
- `EGRESS_DENY_RANGES`, `EGRESS_REFUSED_CODE`
- `egressModeFromEnv()`

**Drift test** — two spec files, one per repo, each asserting the local `egress-policy.ts` matches a **canonical constant block** inlined in the test itself. The constant block is byte-identical in both spec files:
- `back/test/egress-policy-drift.spec.ts`
- `worker/test/egress-policy-drift.spec.ts`

Each spec:
1. Imports `EGRESS_DENY_RANGES` and the exported function names from the local egress-policy.ts.
2. Compares `EGRESS_DENY_RANGES` against a `CANONICAL_DENY_RANGES` constant hardcoded at the top of the spec file.
3. Compares the sorted list of exported names against `CANONICAL_EXPORTS` (also hardcoded).
4. The `CANONICAL_DENY_RANGES` + `CANONICAL_EXPORTS` blocks are **identical** in both spec files — same bytes.

Changing `egress-policy.ts` on one side requires updating the local spec's canonical block AND the sibling repo's spec file in the same PR cycle. If only one side is updated, that side ships; the other side's CI still passes because its canonical block still matches its (unchanged) module. The **next** PR on the stale side detects the mismatch — the canonical block in that side's spec now differs from its own module. Not perfect, but it catches drift within one PR cycle and needs no cross-repo filesystem access.

A README line in both repos: "If you change `egress-policy.ts`, update `test/egress-policy-drift.spec.ts` AND the sibling repo's copy in the same cycle." The spec update section below (TASK-S6B-SSRF-GAPS.md) also records this contract.

**`back/src/app-api/api_call/api_call.service.ts`**:
- `executeApiCall` → before building `axiosConfig`, call `await assertEgressAllowed(body.url, { mode: egressModeFromEnv() })`.
- `axiosConfig` spreads `egressHttpConfig(egressOptions)` so the pin + redirect guard apply to the actual request.
- Add `maxRedirects: 0`. **Known behaviour change**: today the back follows redirects via axios defaults; after this change, a redirect returns a 3xx that the user sees as a `RedirectRefusedError`. The worker safe-fetch has refused redirects in production since 2026-10-19 without incident, so the risk is low. If a user reports a broken API-call flow after shipping, raising this knob to a small positive number (per-call, via the request body) is a tracked follow-up — not shipped in S6b.

**`back/src/app-api/downloader/`**:
- `downloader.service.ts` deleted.
- `downloader.controller.ts` keeps the `@Get()` handler but drops the `DownloaderService` dependency (it already only uses `AwsService.getFile`).
- `app-api.module.ts`: remove `DownloaderService` from `providers` (line 381) and the import (line 122).

### Env vars

**Back `.env.example`** adds:
```
PROXY_ALLOWED_HOSTS=
EGRESS_POLICY_MODE=report
```

Deployment: dev → `EGRESS_POLICY_MODE=report`; staging and prod → `EGRESS_POLICY_MODE=enforce` (matches worker since 2026-10-19). `PROXY_ALLOWED_HOSTS` must be populated per environment with the CloudFront host + image bucket hosts; empty value in prod means `/proxy` refuses all traffic.

### Spec update

`.claude/tasks/worker-flow-execution-epic/TASK-S6B-SSRF-GAPS.md` gains a "Sweep (recorded)" section with the 5 worker fetch sites + the 3 back sites, each listed with file:line and the final state (`guarded via SafeFetch` / `deleted` / `guarded via egress port`). Final line: "No other outbound fetch of a user-supplied URL remained unguarded as of <merge date>."

## Verification

Mirrors the spec's verification section, grounded in this design:

1. **Negative control — DNS pinning.** A test host (`dns-pin-test.local` → stubbed resolver returning one public + one 127.x.x.x) passes safe-fetch on current `main`. After the rewrite it is refused. Remove the `lookup` override and the test fails. Lives in `worker/src/modules/safe-fetch/safe-fetch.service.spec.ts`.
2. **`/proxy` auth.** `GET /proxy?url=https://d123.cloudfront.net/foo` without `Authorization` → 401.
3. **`/proxy` allowlist.** With a valid token and `url=https://example.com/foo` (not in `PROXY_ALLOWED_HOSTS`) → 403.
4. **`/proxy` success path.** With a valid token and `url=` an allowed host → 200 with the image bytes.
5. **`/api_call` denied.** POST with `url=http://169.254.169.254/latest/meta-data/` → the WS receives `{ error: "This URL points to an address that is not allowed." }` and the HTTP response was still a 200 ack (unchanged — the controller is fire-and-forget).
6. **Drift test.** Mutate one `EGRESS_DENY_RANGES` entry in one repo → both repos' CI fail.
7. **Front — modals load images.** Playwright run against the local stack opens a flow with an image, triggers `ExpandImageModal` and `MaskImageEditModal`, confirms the images render through the new blob-URL path.

All verification runs locally. Never probe a production endpoint to prove a gap.

## Rollback

- `/proxy`: revert `ProxyModule` + restore `createProxyMiddleware` block.
- Worker safe-fetch: `safe-fetch.service.ts`'s public surface is preserved; a revert of `safe-dispatcher.ts`/`safe-axios.ts` + the restored `egress-policy.service.ts` gets back to the old 10-range behaviour.
- Back `/api_call`: `egressHttpConfig` is a diff-additive change on `axiosConfig`; removing it + the `assertEgressAllowed` call is a one-commit revert.
- Env flag: `EGRESS_POLICY_MODE=off` disables all A9 checks worldwide without a code change.

## Files touched

**Back:**
- `src/main.ts` (delete `/proxy` middleware)
- `src/app-api/proxy/proxy.module.ts` (new)
- `src/app-api/proxy/proxy.controller.ts` (new)
- `src/app-api/proxy/proxy.service.ts` (new)
- `src/app-api/api_call/api_call.service.ts`
- `src/app-api/downloader/downloader.service.ts` (delete)
- `src/app-api/downloader/downloader.controller.ts` (drop DownloaderService dep)
- `src/app-api/app-api.module.ts` (drop import + provider)
- `src/app.module.ts` (import `ProxyModule`)
- `src/common/egress/egress-policy.ts` (new, port of A9)
- `test/egress-policy-drift.spec.ts` (new)
- `.env.example`

**Worker:**
- `src/modules/safe-fetch/safe-dispatcher.ts`
- `src/modules/safe-fetch/safe-axios.ts`
- `src/modules/safe-fetch/safe-fetch.service.ts`
- `src/modules/safe-fetch/egress-policy.service.ts` (delete)
- `src/modules/safe-fetch/safe-fetch.service.spec.ts`
- `src/modules/safe-fetch/egress-policy.service.spec.ts` (delete)
- `src/modules/nodes/audio-transcriber/audio-transcriber.service.ts`
- `src/modules/nodes/audio-transcriber/google-speech.ts`
- `src/modules/nodes/image-reader/providers/google-docai-base.ts`
- `src/modules/nodes/image-reader/image-reader.module.ts` (if needed to inject SafeFetch)
- `src/modules/nodes/push-data/push-data.service.ts`
- `src/modules/nodes/push-data/push-data.module.ts` (if needed)
- `src/modules/nodes/text-generator/multimodal-file-processor.ts`
- `src/modules/nodes/text-generator/text-generator.module.ts` (if needed)
- `test/egress-policy-drift.spec.ts` (new)

**Front:**
- `src/hooks/useProxiedImage.ts` (new)
- `src/components/ExpandImageModal/ExpandImageModal.tsx`
- `src/components/MaskImageEditModal/MaskImageEditModal.tsx`

**Spec:**
- `.claude/tasks/worker-flow-execution-epic/TASK-S6B-SSRF-GAPS.md` (append sweep section)
