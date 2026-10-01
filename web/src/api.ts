export interface Setup {
  tenant_id: string;
  client_id: string;
  environment: string;
  company: string;
  base_url: string;
  has_client_secret: boolean;
  updated_at: string;
}

export interface Customer {
  id: string;
  number: string | null;
  display_name: string | null;
  email: string | null;
  phone_number: string | null;
  city: string | null;
  country: string | null;
  currency_code: string | null;
  blocked: string | null;
  balance: string | null;
  last_modified: string | null;
  synced_at: string;
}

export type Rec = Record<string, unknown>;

export interface ItemsPage {
  items: Rec[];
  nextLink?: string;
}

export interface NavigationResult {
  kind: "collection" | "record";
  items: Rec[];
}

export interface ActionOutcome {
  id: string;
  ok: boolean;
  status?: number;
  error?: string;
  result?: unknown;
}

export interface LiveEntityConfig {
  label: string;
  actions: string[];
}

export interface EntityField {
  name: string;
  type: string;
}

export interface LiveQuery {
  next?: string;
  select?: string[];
  filter?: string;
  orderby?: string[];
}

export interface DeliveryLine {
  id: string;
  line_no: number;
  item_no: string;
  quantity: string;
  created_at: string;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  // Only send a JSON content-type when there is actually a body — otherwise
  // Fastify rejects the empty body with FST_ERR_CTP_EMPTY_JSON_BODY (400).
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (init?.body != null) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export const api = {
  getSetup: () => req<Setup>("/api/setup"),
  saveSetup: (data: Record<string, string>) =>
    req<{ ok: true }>("/api/setup", { method: "PUT", body: JSON.stringify(data) }),
  test: () =>
    req<{ ok: true; companies: { id: string; name: string }[] }>("/api/setup/test", {
      method: "POST",
    }),
  pullCustomers: () =>
    req<{ ok: true; count: number }>("/api/setup/pull-customers", { method: "POST" }),
  getCustomers: (q: string) =>
    req<{ customers: Customer[]; count: number }>(
      `/api/customers?q=${encodeURIComponent(q)}`,
    ),
  liveEntities: () => req<Record<string, LiveEntityConfig>>("/api/live-entities"),
  getLive: (entity: string, q: LiveQuery = {}) => {
    const p = new URLSearchParams();
    if (q.next) p.set("next", q.next);
    if (q.select && q.select.length) p.set("select", q.select.join(","));
    if (q.filter) p.set("filter", q.filter);
    if (q.orderby && q.orderby.length) p.set("orderby", q.orderby.join(","));
    const qs = p.toString();
    return req<ItemsPage>(`/api/live/${entity}${qs ? `?${qs}` : ""}`);
  },
  getLiveFields: (entity: string) =>
    req<{ fields: EntityField[] }>(`/api/live/${entity}/fields`),
  getLiveNavProps: (entity: string) =>
    req<{ navProperties: string[] }>(`/api/live/${entity}/nav-properties`),
  getLiveNavigation: (entity: string, id: string, nav: string) =>
    req<NavigationResult>(
      `/api/live/${entity}/${encodeURIComponent(id)}/navigation/${encodeURIComponent(nav)}`,
    ),
  // Example 1 — single entry, single mutation.
  runAction: (entity: string, id: string, action: string, parameters?: unknown) =>
    req<{ outcome: ActionOutcome }>(
      `/api/live/${entity}/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`,
      { method: "POST", body: parameters != null ? JSON.stringify(parameters) : undefined },
    ),
  // Example 2 — bulk execution.
  runBulkAction: (entity: string, action: string, ids: string[], parameters?: unknown) =>
    req<{ outcomes: ActionOutcome[] }>(
      `/api/live/${entity}/actions/${encodeURIComponent(action)}`,
      { method: "POST", body: JSON.stringify({ ids, parameters }) },
    ),

  // Delivery sheet (persisted)
  getDeliverySheet: () => req<{ lines: DeliveryLine[] }>("/api/delivery-sheet"),
  addDeliveryLine: (item_no: string, quantity: number) =>
    req<{ line: DeliveryLine }>("/api/delivery-sheet", {
      method: "POST",
      body: JSON.stringify({ item_no, quantity }),
    }),
  deleteDeliveryLine: (id: string) =>
    req<{ ok: true }>(`/api/delivery-sheet/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // Marinar custom API (Create sales order)
  marinarCustomers: (q: string) =>
    req<{ customers: Rec[] }>(`/api/marinar/customers?q=${encodeURIComponent(q)}`),
  marinarShipTo: (customerNumber: string) =>
    req<{ shipToAddresses: Rec[] }>(
      `/api/marinar/ship-to-addresses?customerNumber=${encodeURIComponent(customerNumber)}`,
    ),
  marinarDeliveryTypes: () =>
    req<{ deliveryTypes: string[] }>("/api/marinar/delivery-types"),
  createSalesOrder: (input: {
    customerNumber: string;
    shipToCode?: string;
    deliveryType?: string;
    orderDate?: string;
  }) =>
    req<{ order: Rec }>("/api/marinar/sales-orders", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  // Live item lookup by number (reuses the generic live endpoint with $select + $filter).
  // BC rejects OR across distinct fields, so we filter on the number only.
  lookupItems: (q: string) => {
    const esc = q.replace(/'/g, "''");
    return api.getLive("items", {
      select: ["id", "number", "displayName", "baseUnitOfMeasureCode"],
      filter: `contains(number,'${esc}')`,
      orderby: ["number"],
    });
  },
};
