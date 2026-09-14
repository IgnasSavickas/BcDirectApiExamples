# BC Data

A .NET Aspire application that reads **Microsoft Dynamics 365 Business Central**
data and surfaces it through a TypeScript web UI. It demonstrates two ways of
consuming BC data — **persisted** (pulled into PostgreSQL) and **live**
(streamed straight from BC per request) — plus **bound-action** mutations.

> **Reading this to continue the work?** Jump to
> [Business Central integration concepts](#business-central-integration-concepts).
> That section is the point of this document: it explains *how* BC communication
> is implemented here so you can extend it without rediscovering the details.

---

## What it does

Three data flows, each a worked example of a different BC integration pattern:

1. **Customers** — *persisted*. Pull the full `customers` dataset from BC into
   PostgreSQL, then serve/search it from the database. Pattern: **ETL / cache**.
2. **Items** — *live, read-only*. Stream `items` directly from BC per request
   with server-side paging, `$select`/`$filter`/`$orderby`, and navigation-
   property drill-down. Pattern: **live query passthrough**.
3. **Purchase Orders** — *live + mutations*. Same live pattern as Items, plus the
   `receiveAndInvoice` **bound action**, exposed two ways: single-record and
   bulk. Pattern: **live query + write-back**.

---

## Architecture

```
┌────────────────────────── BcData.AppHost (C# / .NET Aspire) ──────────────────────────┐
│  Orchestrates everything, injects connection strings + service discovery URLs.         │
│                                                                                        │
│   ┌─────────────┐        ┌──────────────────────────┐        ┌──────────────────────┐  │
│   │  postgres   │◀──────▶│   api  (Node + Fastify)   │◀──────▶│  web (Vite + React)  │  │
│   │  (+ pgAdmin)│  SQL   │   @navapi/core → BC        │  HTTP  │  proxies /api → api  │  │
│   └─────────────┘        └────────────┬─────────────┘        └──────────────────────┘  │
└──────────────────────────────────────┼─────────────────────────────────────────────────┘
                                        │ HTTPS (OAuth2 client credentials)
                                        ▼
                         Business Central (official API v2, route `v2.0`)
```

- **AppHost** wires the graph. Aspire injects `ConnectionStrings__bcdata` into
  `api`, and a service-discovery URL (`services__api__http__0`) into `web`, and a
  `PORT` for each Node app to listen on. See [`BcData.AppHost/AppHost.cs`](BcData.AppHost/AppHost.cs).
- **api** owns all BC communication and the database. It never ships secrets to
  the browser. See [`api/src/`](api/src).
- **web** is a thin SPA. In dev, Vite proxies `/api/*` to the api service so the
  browser always talks same-origin. See [`web/src/`](web/src).

The BC client secret lives **server-side only** (in the `bc_setup` table). The
browser never receives it, and every BC call is made from `api`.

---

## Prerequisites & run

- .NET 10 SDK + Aspire CLI (`aspire --version`), Node.js 20+, Docker.

```bash
cd BcData.AppHost
aspire run
```

The Aspire dashboard lists `postgres`, `api`, `web`. Open the `web` endpoint.
On a fresh clone, run `npm install` in both `api/` and `web/` first (Aspire runs
the apps but does not install their dependencies).

To use it: **Setup** tab → enter BC connection → **Pull customers** and/or open
the **Items** / **Purchase Orders** live tabs.

---

## Repo layout

```
BcData.AppHost/AppHost.cs        Aspire orchestration (postgres + api + web)
api/                             Node + TypeScript backend (all BC + DB logic)
  src/db.ts                      Postgres pool, connection-string parsing, schema, setup table
  src/bc.ts                      ★ ALL Business Central logic (navapi) — read this first
  src/server.ts                  Fastify HTTP routes
web/                             Vite + React + TypeScript frontend
  src/api.ts                     Typed fetch client for the api
  src/pages/Setup.tsx            BC connection form + Pull/Test buttons
  src/pages/Customers.tsx        DB-backed list
  src/pages/LiveEntity.tsx       ★ Generic live grid: paging, $select/$filter/$orderby, drill-down, actions
```

`api/src/bc.ts` is the heart of the integration. Everything below maps to code there.

---

## Business Central integration concepts

This section is the handoff. Each concept notes the BC/OData rule and where it
lives in the code.

### 1. The library: `@navapi/core`

BC communication goes through [`@navapi/core`](https://github.com/JeremyVyska/navapi)
(npm, currently `0.3.0`) — a thin, typed OData client for BC that handles token
caching, `$metadata` discovery, ETags, pagination, and company scoping. We use
only the `@navapi/core` library (not its CLI/MCP faces).

The two types we build everything from:

```ts
import { BcClient, ClientCredentialsAuth } from "@navapi/core";

const auth = new ClientCredentialsAuth({ tenantId, clientId, clientSecret });
const client = new BcClient({
  profile: { name, credential, tenantId, environment, company?, baseUrl? },
  auth,
});
```

`makeClient(setup)` in `bc.ts` constructs this from a stored setup row. Every
other function takes a `setup` and builds a client — clients are cheap and
stateless-per-request here.

### 2. Authentication — OAuth2 client credentials (Entra ID)

BC is called with an **app-only** token from an Entra ID (Azure AD) **app
registration**. `ClientCredentialsAuth` runs the client-credentials flow against
`https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token` with scope
`https://api.businesscentral.dynamics.com/.default`, and caches the token until
shortly before expiry.

Requirements on the BC side (not code — environment setup):
- An app registration with a **client secret**.
- That app registered in BC as an **Application user** with a permission set
  (e.g. `D365 BASIC` / `D365 FULL ACCESS`, or read-only for read scenarios).

A wrong secret surfaces as `AADSTS7000215: Invalid client secret provided` — a
token-endpoint error, not a BC error. navapi also supports Azure CLI delegated
auth (`AzureCliAuth`), unused here.

### 3. The setup table — connection config

Connection details are stored in a single-row Postgres table `bc_setup`
(`tenant_id`, `client_id`, `client_secret`, `environment`, `company`,
`base_url`). See the schema in [`api/src/db.ts`](api/src/db.ts).

- **The secret is stored plaintext**, by design (the app *is* the connection
  manager). Fine for local/internal use; for anything shared, move it to a
  secret store (Key Vault, Aspire parameters) and keep only a reference.
- `GET /api/setup` **redacts** the secret (`has_client_secret: boolean` instead
  of the value). `PUT /api/setup` treats a blank secret as "keep the existing
  one" — so the UI can show `••••• (leave blank to keep)`.

### 4. Company scoping

Almost every BC entity is **company-scoped**: the URL is
`…/companies({companyId})/customers`. A tenant/environment can hold several
companies. `resolveCompany(client, setup)` in `bc.ts` resolves the configured
company name to a GUID, or falls back to the **first** company if none is set.
`client.listCompanies()` lists them; `companyLabel(c)` gives a display name.

`Test connection` (`POST /api/setup/test`) simply lists companies — the cheapest
way to prove auth + connectivity end to end.

### 5. The API surface — official Microsoft API v2 (`v2.0` route)

BC exposes multiple API "routes": the standard Microsoft API, custom per-
publisher APIs, and published OData pages. navapi's `STANDARD_ROUTE = "v2.0"` is
the **official Microsoft API v2**, and `client.list("customers")` targets it by
default. Entity set names are the v2 names: `customers`, `items`,
`purchaseOrders`, etc. This project uses only the standard `v2.0` route.

### 6. Reading data — `list`, and the OData query options

```ts
const { items, nextLink, count } = await client.list("items", {
  company,
  maxPageSize: 30,                 // native server-side paging (see §7)
  query: {
    select: ["id", "number", "displayName"],   // → $select
    filter: "unitPrice gt 100",                // → $filter
    orderby: ["number desc"],                  // → $orderby
  },
});
```

- **`$select`** (`listEntity` `opts.select`) — narrows returned fields. Hiding a
  column in the UI removes it from `$select`, so BC never sends it. **`id` is
  always forced into the select** server-side, because row keys, drill-down, and
  actions need it even when its column is hidden.
- **`$filter`** — a raw OData expression. The UI builds it **type-aware** from
  `$metadata`: string fields → `eq`/`ne`/`contains`/`startswith`/`endswith`;
  numeric/date fields → `eq ne gt ge lt le`. Values are formatted as OData
  literals (strings quoted and `'`-escaped, numbers/dates bare, booleans
  `true`/`false`). See `buildFilter`/`formatValue` in `LiveEntity.tsx`.
- **`$orderby`** — `["field asc|desc"]`. The UI sets one clause by clicking a
  column header (cycles asc → desc → off).

The api exposes these as query params on `GET /api/live/:entity`
(`?select=a,b&filter=…&orderby=field desc`), parsed in `server.ts` and passed to
`listEntity`.

### 7. Native paging — `maxPageSize` + `nextLink` (not `$top`/`$skip`)

Server-driven paging uses the `Prefer: odata.maxpagesize=30` header (navapi's
`maxPageSize`), **not** `$top`/`$skip`. BC returns 30 rows plus an
`@odata.nextLink` that encodes an opaque skip token **and the original query**
(`$select`/`$filter`/`$orderby`). To page:

```ts
const first = await client.list("items", { company, maxPageSize: 30, query });
const second = await client.followNextLink(first.nextLink, { maxPageSize: 30 });
```

Consequences baked into the design:
- The **first** page carries the query; **subsequent** pages just follow
  `nextLink` (the query rides along), so `listEntity` ignores `select/filter/
  orderby` whenever `next` is present.
- The frontend keeps a **stack of nextLinks** for Prev/Next (`LiveEntity.tsx`),
  and resets it to page 1 whenever the query (columns/filter/sort) changes.
- `client.list(..., { all: true })` instead follows every `nextLink` to exhaust
  the collection — that's how the **customers pull** fetches everything at once
  (`syncCustomers`).

### 8. Metadata — fields and navigation properties

`client.getMetadata("v2.0")` returns parsed `$metadata` (cached by navapi). From
the entity set we read:
- **`properties`** → the scalar fields `{ name, type }` (EDM types like
  `Edm.String`, `Edm.Decimal`). Drives the Columns picker and type-aware filter.
  Exposed as `GET /api/live/:entity/fields` (`entityFields` in `bc.ts`).
- **`navigationProperties`** → the expandable relations (see §9). Exposed as
  `GET /api/live/:entity/nav-properties` (`entityNavProperties`).

Metadata is how the UI stays generic: it never hard-codes a field list.

### 9. Drill-down — navigation properties (not `$expand`)

The grids deliberately request **no `$expand`** (only direct fields). To inspect
a related record, we fetch the navigation property on demand:

```ts
const { kind, items } = await client.getNavigation("items", id, "unitOfMeasure", { company });
// kind: "record" for single-valued (unitOfMeasure), "collection" for many (purchaseOrderLines)
```

`entityNavigation` validates the property name against `$metadata` before using
it in a URL (defense against arbitrary path injection). The drawer in
`LiveEntity.tsx` renders `record` as a key/value list and `collection` as a
table.

### 10. Bound actions — mutations (`receiveAndInvoice`)

Entities expose **bound actions** in `$metadata` (`entitySet.actions`). A bound
action is a POST to `…/purchaseOrders({id})/Microsoft.NAV.receiveAndInvoice`.
navapi's `callAction` qualifies the unqualified name with the schema namespace
(`Microsoft.NAV`) automatically:

```ts
await client.callAction("purchaseOrders", id, "receiveAndInvoice", { company, parameters });
```

Two execution models are implemented (both in `bc.ts`):

- **Single entry, single mutation** — `callEntityAction`: one `callAction` for
  one record. Exposed at `POST /api/live/:entity/:id/actions/:action`.
- **Bulk** — `bulkEntityAction`: the same action across many records, run as
  **independent concurrent mutations** (`Promise.allSettled`), returning a
  per-record `ActionOutcome`. Exposed at `POST /api/live/:entity/actions/:action`
  with `{ ids, parameters? }`.

> **Why not one OData `$batch`?** We tried it. BC **aborts the batch at the first
> failed sub-request** (later ones come back "missing"), so one bad record blocks
> the rest. Independent concurrent calls give a real per-record success/failure
> report, which is what a bulk-post UX needs. If you re-introduce `$batch`, you'd
> need `Prefer: odata.continue-on-error`, which navapi's `batch()` does not
> currently expose.

Safety: `receiveAndInvoice` **posts a receipt + invoice — irreversible**. Both
UI paths confirm before running, and actions are allow-listed per entity (see
§11). Verify wiring with a bogus GUID (BC returns 404, no side effects) rather
than posting a real order.

### 11. Allow-listing entities and actions

The generic `/api/live/:entity` routes could otherwise be pointed at any entity
or action. `LIVE_ENTITIES` in `bc.ts` is the allow-list:

```ts
export const LIVE_ENTITIES = {
  items:          { label: "Items",           actions: [] },
  purchaseOrders: { label: "Purchase Orders", actions: ["receiveAndInvoice"] },
};
```

`assertEntity` / `assertAction` reject anything not listed. Navigation property
names are separately validated against `$metadata`.

### 12. Two persistence models, side by side

| | Customers | Items / Purchase Orders |
|---|---|---|
| Source at read time | PostgreSQL | Business Central (per request) |
| BC call | `list(..., { all: true })` once, on **Pull** | `list(..., { maxPageSize })` every page view |
| Freshness | as of last pull | always current |
| Query pushdown | SQL (`ILIKE`) | OData `$select`/`$filter`/`$orderby` |
| Code | `syncCustomers` + SQL upsert | `listEntity` + `LiveEntity.tsx` |

Use the **persisted** model for data you search/join/report on heavily or want
offline; use the **live** model for always-current reads and for anything you
also mutate.

---

## API endpoints

All under `api`. Errors return `4xx` with `{ "error": "<message>" }`; the
frontend surfaces that message.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/setup` | Current setup (secret redacted) |
| PUT | `/api/setup` | Save setup (blank secret keeps existing) |
| POST | `/api/setup/test` | List BC companies (verifies auth) |
| POST | `/api/setup/pull-customers` | `list(all)` customers → upsert into Postgres |
| GET | `/api/customers?q=` | Customers from Postgres |
| GET | `/api/live-entities` | Live entities + their allowed actions |
| GET | `/api/live/:entity?select=&filter=&orderby=&next=` | One page, live (30/page) |
| GET | `/api/live/:entity/fields` | Scalar fields `{name,type}` from `$metadata` |
| GET | `/api/live/:entity/nav-properties` | Navigation (expand) property names |
| GET | `/api/live/:entity/:id/navigation/:nav` | Drill into one navigation property |
| POST | `/api/live/:entity/:id/actions/:action` | **Single** bound-action mutation |
| POST | `/api/live/:entity/actions/:action` | **Bulk** bound-action mutation (`{ids,parameters?}`) |

---

## Gotchas & lessons learned

Real issues hit while building this — worth knowing before you touch it:

- **Empty-body POST + `Content-Type: application/json` → 400 "Bad Request".**
  Fastify rejects an empty JSON body (`FST_ERR_CTP_EMPTY_JSON_BODY`). The action
  POSTs carry no body, so `server.ts` registers a content-type parser that treats
  an empty body as `{}`, and the frontend only sets the JSON content-type when
  there *is* a body (`web/src/api.ts`). This bit us as a generic 400 that hid the
  real error.
- **Aspire's Postgres connection string is ADO.NET format**
  (`Host=…;Port=…;Username=…;Password=…;Database=…`), not a `postgres://` URL.
  `parseAspireConnectionString` in `db.ts` translates it to a `pg` config.
- **BC `$batch` stops at the first error** — see §10. Hence concurrent
  independent mutations for bulk.
- **`$select` drops fields you still need internally.** Always keep `id` (§6).
- **`nextLink` already contains the query** — don't re-append `$select`/`$filter`
  when following it (§7).
- **Company display name vs. what you type.** `"Tenging"` resolves to
  `"Tenging ehf."`; resolution is fuzzy, but store what BC returns when you
  can.

---

## Adding a new dataset (recipe)

To expose another standard v2 entity, e.g. `salesOrders`:

1. **Allow-list it** in `LIVE_ENTITIES` (`bc.ts`), with any bound actions you
   want to enable (check `entitySet.actions` in `$metadata` first).
2. **Add a tab** in `web/src/App.tsx`:
   ```tsx
   <LiveEntity entity="salesOrders" title="Sales Orders — live"
     actions={[{ name: "shipAndInvoice", label: "Ship and Invoice" }]} />
   ```
   That's it for a live, read-only-or-with-actions dataset — the generic
   backend routes and `LiveEntity` component already handle paging,
   `$select`/`$filter`/`$orderby`, drill-down, and single/bulk actions.
3. **Want it persisted instead?** Add a table in `db.ts`, write a `syncX`
   function modelled on `syncCustomers` (`list({ all: true })` + upsert), and a
   pull endpoint. Serve it from SQL like `/api/customers`.

To wire a **new bound action**, no code change beyond step 1 is needed — the
generic action endpoints and `LiveEntity` action UI pick up whatever is in the
entity's `actions` list. Always confirm before irreversible posts.

---

## Security notes

- BC client secret is stored **plaintext** in `bc_setup` and lives only
  server-side; the browser never receives it. Move it to a secret store for
  shared deployments.
- Entities and actions are **allow-listed**; navigation property names are
  validated against `$metadata` before use in URLs.
- Bound actions post real, **irreversible** documents. Both action paths confirm
  first; test wiring with bogus GUIDs, not real records.
