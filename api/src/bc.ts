import {
  BcClient,
  ClientCredentialsAuth,
  companyLabel,
  STANDARD_ROUTE,
  type BcRecord,
  type ProfileConfig,
} from "@navapi/core";
import { pool, type SetupRow } from "./db.js";

export class SetupError extends Error {}

/** Resolves the company to use: the configured one, else the first available. */
async function resolveCompany(client: BcClient, setup: SetupRow): Promise<string> {
  if (setup.company) return setup.company;
  const companies = await client.listCompanies();
  if (companies.length === 0) {
    throw new SetupError("No companies are available for this credential.");
  }
  return companyLabel(companies[0]);
}

/** Builds a navapi BcClient (targeting the official v2.0 API route) from setup. */
export function makeClient(setup: SetupRow): BcClient {
  if (!setup.tenant_id) throw new SetupError("Tenant ID is not configured.");
  if (!setup.client_id) throw new SetupError("Client ID is not configured.");
  if (!setup.client_secret) throw new SetupError("Client secret is not configured.");

  const profile: ProfileConfig = {
    name: "bcdata",
    credential: "app",
    tenantId: setup.tenant_id,
    environment: setup.environment || "Production",
    company: setup.company || undefined,
    baseUrl: setup.base_url || undefined,
  };

  const auth = new ClientCredentialsAuth({
    tenantId: setup.tenant_id,
    clientId: setup.client_id,
    clientSecret: setup.client_secret,
  });

  return new BcClient({ profile, auth });
}

/** Returns the companies visible to the configured credential. */
export async function listCompanies(setup: SetupRow) {
  const client = makeClient(setup);
  const companies = await client.listCompanies();
  return companies.map((c) => ({ id: c.id, name: companyLabel(c) }));
}

function toNumber(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : (value as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return value == null ? null : String(value);
}

/**
 * Pulls every customer from the official Microsoft API v2 (`customers`
 * entity set on the v2.0 route) and upserts them into the customers table.
 * Returns how many records were written.
 */
export async function syncCustomers(setup: SetupRow): Promise<number> {
  const client = makeClient(setup);
  const company = await resolveCompany(client, setup);

  const { items } = await client.list("customers", { all: true, company });

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");
    for (const c of items as BcRecord[]) {
      await dbClient.query(
        `INSERT INTO customers (
            id, number, display_name, email, phone_number, address_line1,
            city, country, postal_code, currency_code, blocked, balance,
            last_modified, raw, synced_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
         ON CONFLICT (id) DO UPDATE SET
            number        = EXCLUDED.number,
            display_name  = EXCLUDED.display_name,
            email         = EXCLUDED.email,
            phone_number  = EXCLUDED.phone_number,
            address_line1 = EXCLUDED.address_line1,
            city          = EXCLUDED.city,
            country       = EXCLUDED.country,
            postal_code   = EXCLUDED.postal_code,
            currency_code = EXCLUDED.currency_code,
            blocked       = EXCLUDED.blocked,
            balance       = EXCLUDED.balance,
            last_modified = EXCLUDED.last_modified,
            raw           = EXCLUDED.raw,
            synced_at     = now()`,
        [
          str(c.id) ?? str(c.number) ?? crypto.randomUUID(),
          str(c.number),
          str(c.displayName),
          str(c.email),
          str(c.phoneNumber),
          str(c.addressLine1),
          str(c.city),
          str(c.country),
          str(c.postalCode),
          str(c.currencyCode),
          str(c.blocked),
          toNumber(c.balance),
          str(c.lastModifiedDateTime),
          JSON.stringify(c),
        ],
      );
    }
    await dbClient.query("COMMIT");
  } catch (err) {
    await dbClient.query("ROLLBACK");
    throw err;
  } finally {
    dbClient.release();
  }

  return items.length;
}

// ---------------------------------------------------------------------------
// Live entities — served directly from BC (no database), with native
// server-driven paging, navigation-property drill-down, and bound actions.
// ---------------------------------------------------------------------------

export const LIVE_PAGE_SIZE = 30;

/**
 * The entities exposed on the live tabs, each with the bound actions the UI
 * is allowed to invoke. Acts as an allow-list so a caller can never point the
 * generic routes at an arbitrary entity or action.
 */
export const LIVE_ENTITIES: Record<string, { label: string; actions: string[] }> = {
  items: { label: "Items", actions: [] },
  purchaseOrders: { label: "Purchase Orders", actions: ["receiveAndInvoice"] },
};

export function assertEntity(entity: string): void {
  if (!Object.prototype.hasOwnProperty.call(LIVE_ENTITIES, entity)) {
    throw new SetupError(`Unknown live entity: ${entity}`);
  }
}

function assertAction(entity: string, action: string): void {
  assertEntity(entity);
  if (!LIVE_ENTITIES[entity].actions.includes(action)) {
    throw new SetupError(`Action '${action}' is not allowed on ${entity}.`);
  }
}

export interface EntityPage {
  items: BcRecord[];
  /** Present when more pages exist; pass back to fetch the next page. */
  nextLink?: string;
}

export interface ListEntityOptions {
  /** Page token (BC @odata.nextLink); carries the query, so ignore the rest. */
  next?: string;
  /** OData $select — the fields to return (id is always included). */
  select?: string[];
  /** OData $filter expression. */
  filter?: string;
  /** OData $orderby clauses, e.g. ["number desc"]. */
  orderby?: string[];
}

/**
 * One page of an entity. The first call scopes to the company and applies the
 * $select / $filter / $orderby query; subsequent pages follow the BC
 * `@odata.nextLink`, which already carries that query. No `$expand` is
 * requested, so only direct fields come back.
 */
export async function listEntity(
  setup: SetupRow,
  entity: string,
  opts: ListEntityOptions = {},
): Promise<EntityPage> {
  assertEntity(entity);
  const client = makeClient(setup);
  if (opts.next) {
    const res = await client.followNextLink(opts.next, { maxPageSize: LIVE_PAGE_SIZE });
    return { items: res.items, nextLink: res.nextLink };
  }
  const company = await resolveCompany(client, setup);

  const query: { select?: string[]; filter?: string; orderby?: string[] } = {};
  if (opts.select && opts.select.length) {
    // id must come back for row keys, drill-down and actions.
    const sel = new Set(opts.select);
    sel.add("id");
    query.select = [...sel];
  }
  if (opts.filter) query.filter = opts.filter;
  if (opts.orderby && opts.orderby.length) query.orderby = opts.orderby;

  const res = await client.list(entity, { company, maxPageSize: LIVE_PAGE_SIZE, query });
  return { items: res.items, nextLink: res.nextLink };
}

export interface EntityField {
  name: string;
  /** EDM type, e.g. Edm.String, Edm.Decimal, Edm.Boolean, Edm.Date. */
  type: string;
}

/** The scalar fields an entity exposes (for the column / filter / sort UI). */
export async function entityFields(setup: SetupRow, entity: string): Promise<EntityField[]> {
  assertEntity(entity);
  const client = makeClient(setup);
  const cached = await client.getMetadata(STANDARD_ROUTE);
  const found = cached.metadata.entitySets.find((e) => e.name === entity);
  return found ? found.properties.map((p) => ({ name: p.name, type: p.type })) : [];
}

/** The navigation (expand) properties an entity exposes, from $metadata. */
export async function entityNavProperties(setup: SetupRow, entity: string): Promise<string[]> {
  assertEntity(entity);
  const client = makeClient(setup);
  const cached = await client.getMetadata(STANDARD_ROUTE);
  const found = cached.metadata.entitySets.find((e) => e.name === entity);
  return found ? found.navigationProperties.map((n) => n.name) : [];
}

export interface NavigationResult {
  kind: "collection" | "record";
  items: BcRecord[];
}

/**
 * Drills into one navigation property of a single record. The property name
 * is validated against $metadata before it is used to build the URL.
 */
export async function entityNavigation(
  setup: SetupRow,
  entity: string,
  id: string,
  navProperty: string,
): Promise<NavigationResult> {
  const allowed = await entityNavProperties(setup, entity);
  if (!allowed.includes(navProperty)) {
    throw new SetupError(`Unknown navigation property: ${navProperty}`);
  }
  const client = makeClient(setup);
  const company = await resolveCompany(client, setup);
  return client.getNavigation(entity, id, navProperty, { company });
}

// --- Bound actions --------------------------------------------------------

export interface ActionOutcome {
  id: string;
  ok: boolean;
  status?: number;
  error?: string;
  result?: unknown;
}

/** Invokes one bound action on one record. Never throws — errors become an outcome. */
async function invokeAction(
  client: BcClient,
  company: string,
  entity: string,
  id: string,
  action: string,
  parameters?: unknown,
): Promise<ActionOutcome> {
  try {
    const result = await client.callAction(entity, id, action, { company, parameters });
    return { id, ok: true, result: result ?? null };
  } catch (err) {
    return { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Example 1 — single entry, single mutation. Invokes a bound action on one
 * record (e.g. `receiveAndInvoice` on a purchase order) via a single POST.
 */
export async function callEntityAction(
  setup: SetupRow,
  entity: string,
  id: string,
  action: string,
  parameters?: unknown,
): Promise<ActionOutcome> {
  assertAction(entity, action);
  const client = makeClient(setup);
  const company = await resolveCompany(client, setup);
  return invokeAction(client, company, entity, id, action, parameters);
}

/**
 * Example 2 — bulk execution. Runs the same bound action on many records,
 * each as an independent mutation, concurrently. Unlike an OData `$batch`
 * (which BC aborts at the first error), this attempts every record and
 * returns a per-record outcome, so one failure never blocks the rest.
 */
export async function bulkEntityAction(
  setup: SetupRow,
  entity: string,
  ids: string[],
  action: string,
  parameters?: unknown,
): Promise<ActionOutcome[]> {
  assertAction(entity, action);
  if (ids.length === 0) return [];
  const client = makeClient(setup);
  const company = await resolveCompany(client, setup);

  const settled = await Promise.allSettled(
    ids.map((id) => invokeAction(client, company, entity, id, action, parameters)),
  );
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { id: ids[i], ok: false, error: String(r.reason) },
  );
}

// ---------------------------------------------------------------------------
// Marinar custom API (tenging/marinar/v1.0) — used by the Delivery Sheet's
// "Create sales order" flow. Lives on a custom route, so these call navapi
// with an explicit `route` instead of the default v2.0.
// ---------------------------------------------------------------------------

export const MARINAR_ROUTE = "tenging/marinar/v1.0";

function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}

/** Customer lookup (by number or name) from the custom API. */
export async function marinarCustomers(setup: SetupRow, q: string): Promise<BcRecord[]> {
  const client = makeClient(setup);
  const company = await resolveCompany(client, setup);
  const query: { select?: string[]; filter?: string; orderby?: string[] } = {
    select: ["id", "number", "displayName", "city", "country"],
    orderby: ["number"],
  };
  const term = q.trim();
  if (term) {
    const e = escapeOData(term);
    // BC rejects OR across distinct fields, so pick one: digits → number, else name.
    query.filter = /^\d/.test(term)
      ? `contains(number,'${e}')`
      : `contains(displayName,'${e}')`;
  }
  const res = await client.list("customers", { route: MARINAR_ROUTE, company, maxPageSize: 20, query });
  return res.items;
}

/** Ship-to addresses for one customer, pre-filtered by customerNumber. */
export async function marinarShipToAddresses(
  setup: SetupRow,
  customerNumber: string,
): Promise<BcRecord[]> {
  const client = makeClient(setup);
  const company = await resolveCompany(client, setup);
  const res = await client.list("shipToAddresses", {
    route: MARINAR_ROUTE,
    company,
    maxPageSize: 100,
    query: {
      select: ["id", "customerNumber", "code", "displayName", "city", "country"],
      filter: `customerNumber eq '${escapeOData(customerNumber)}'`,
      orderby: ["code"],
    },
  });
  return res.items;
}

/**
 * The members of the BC `deliveryType` enum, read live from the custom API's
 * $metadata (navapi parses entity sets but not enums, so we parse the XML).
 */
export async function marinarDeliveryTypes(setup: SetupRow): Promise<string[]> {
  if (!setup.tenant_id || !setup.client_id || !setup.client_secret) {
    throw new SetupError("Business Central connection is not configured.");
  }
  const auth = new ClientCredentialsAuth({
    tenantId: setup.tenant_id,
    clientId: setup.client_id,
    clientSecret: setup.client_secret,
  });
  const token = await auth.getToken();
  const baseUrl = setup.base_url || "https://api.businesscentral.dynamics.com";
  const env = setup.environment || "Production";
  const url = `${baseUrl}/v2.0/${setup.tenant_id}/${env}/api/${MARINAR_ROUTE}/$metadata`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new SetupError(`Could not read $metadata (HTTP ${res.status}).`);
  const xml = await res.text();
  const block = xml.match(/<EnumType[^>]*Name="deliveryType"[^>]*>([\s\S]*?)<\/EnumType>/i);
  if (!block) return [];
  return [...block[1].matchAll(/<Member[^>]*Name="([^"]+)"/g)].map((m) => m[1]);
}

export interface SalesOrderLineInput {
  lineType: string; // e.g. "Item"
  lineObjectNumber: string; // the item number
  quantity: number;
}

export interface SalesOrderInput {
  customerNumber: string;
  shipToCode?: string;
  deliveryType?: string;
  orderDate?: string; // yyyy-mm-dd
  lines?: SalesOrderLineInput[];
}

/**
 * Creates a sales order on the custom API via a deep insert — the
 * `salesOrderLines` are nested in the same POST, so header and lines are
 * created in one request. Returns the created record (incl. the order number).
 */
export async function createMarinarSalesOrder(
  setup: SetupRow,
  input: SalesOrderInput,
): Promise<BcRecord> {
  if (!input.customerNumber) throw new SetupError("A customer is required.");
  const client = makeClient(setup);
  const company = await resolveCompany(client, setup);

  const body: Record<string, unknown> = { customerNumber: input.customerNumber };
  if (input.orderDate) body.orderDate = input.orderDate;
  if (input.shipToCode) body.shipToCode = input.shipToCode;
  if (input.deliveryType) body.deliveryType = input.deliveryType;
  if (input.lines && input.lines.length) body.salesOrderLines = input.lines;

  return client.create("salesOrders", body, { route: MARINAR_ROUTE, company });
}
