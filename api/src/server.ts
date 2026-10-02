import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  addDeliveryLine,
  deleteDeliveryLine,
  getSetup,
  listDeliverySheet,
  migrate,
  pool,
  saveSetup,
  type SetupInput,
} from "./db.js";
import {
  bulkEntityAction,
  callEntityAction,
  createMarinarRecord,
  createMarinarSalesOrder,
  deleteMarinarRecord,
  entityFields,
  getMarinarRecord,
  marinarCustomers,
  marinarDeliveryTypes,
  marinarFields,
  marinarOrderLines,
  marinarShipToAddresses,
  updateMarinarRecord,
  type SalesOrderInput,
  entityNavigation,
  entityNavProperties,
  listCompanies,
  listEntity,
  LIVE_ENTITIES,
  SetupError,
  syncCustomers,
} from "./bc.js";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

// Accept empty JSON bodies (e.g. action POSTs that carry no payload) instead
// of failing with FST_ERR_CTP_EMPTY_JSON_BODY.
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (_req, body, done) => {
    const text = (body as string).trim();
    if (text.length === 0) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  },
);

await migrate();

/** Setup, with the secret redacted (never sent to the browser). */
app.get("/api/setup", async () => {
  const s = await getSetup();
  return {
    tenant_id: s.tenant_id,
    client_id: s.client_id,
    environment: s.environment,
    company: s.company,
    base_url: s.base_url,
    has_client_secret: s.client_secret.length > 0,
    updated_at: s.updated_at,
  };
});

app.put<{ Body: SetupInput }>("/api/setup", async (req) => {
  const b = req.body ?? ({} as SetupInput);
  await saveSetup({
    tenant_id: (b.tenant_id ?? "").trim(),
    client_id: (b.client_id ?? "").trim(),
    client_secret: b.client_secret, // blank = keep existing
    environment: (b.environment ?? "Production").trim(),
    company: (b.company ?? "").trim(),
    base_url: (b.base_url ?? "").trim(),
  });
  return { ok: true };
});

/** Test the connection by listing companies. */
app.post("/api/setup/test", async (_req, reply) => {
  try {
    const companies = await listCompanies(await getSetup());
    return { ok: true, companies };
  } catch (err) {
    return reply.status(400).send({ ok: false, error: describe(err) });
  }
});

/** Pull the customers dataset from BC into Postgres. */
app.post("/api/setup/pull-customers", async (_req, reply) => {
  try {
    const count = await syncCustomers(await getSetup());
    return { ok: true, count };
  } catch (err) {
    return reply.status(400).send({ ok: false, error: describe(err) });
  }
});

/** Customers served from Postgres, newest sync first, optional search. */
app.get<{ Querystring: { q?: string; limit?: string } }>(
  "/api/customers",
  async (req) => {
    const q = (req.query.q ?? "").trim();
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const params: unknown[] = [];
    let where = "";
    if (q) {
      params.push(`%${q}%`);
      where = `WHERE display_name ILIKE $1 OR number ILIKE $1 OR email ILIKE $1`;
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT id, number, display_name, email, phone_number, city, country,
              currency_code, blocked, balance, last_modified, synced_at
       FROM customers ${where}
       ORDER BY display_name NULLS LAST
       LIMIT $${params.length}`,
      params,
    );
    return { customers: rows, count: rows.length };
  },
);

// --- Delivery sheet (persisted in Postgres) -------------------------------

app.get("/api/delivery-sheet", async () => {
  return { lines: await listDeliverySheet() };
});

app.post<{ Body: { item_no?: string; quantity?: number | string } }>(
  "/api/delivery-sheet",
  async (req, reply) => {
    const itemNo = (req.body?.item_no ?? "").toString().trim();
    const quantity = Number(req.body?.quantity);
    if (!itemNo) return reply.status(400).send({ error: "item_no is required." });
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return reply.status(400).send({ error: "quantity must be a positive number." });
    }
    // Round to 2 decimal places to match the column.
    const line = await addDeliveryLine(itemNo, Math.round(quantity * 100) / 100);
    return { line };
  },
);

app.delete<{ Params: { id: string } }>("/api/delivery-sheet/:id", async (req) => {
  await deleteDeliveryLine(req.params.id);
  return { ok: true };
});

// --- Marinar custom API (Create sales order flow) -------------------------

app.get<{ Querystring: { q?: string } }>("/api/marinar/customers", async (req, reply) => {
  try {
    return { customers: await marinarCustomers(await getSetup(), req.query.q ?? "") };
  } catch (err) {
    return reply.status(400).send({ error: describe(err) });
  }
});

app.get<{ Querystring: { customerNumber?: string } }>(
  "/api/marinar/ship-to-addresses",
  async (req, reply) => {
    try {
      const cn = (req.query.customerNumber ?? "").trim();
      if (!cn) return { shipToAddresses: [] };
      return { shipToAddresses: await marinarShipToAddresses(await getSetup(), cn) };
    } catch (err) {
      return reply.status(400).send({ error: describe(err) });
    }
  },
);

app.get("/api/marinar/delivery-types", async (_req, reply) => {
  try {
    return { deliveryTypes: await marinarDeliveryTypes(await getSetup()) };
  } catch (err) {
    return reply.status(400).send({ error: describe(err) });
  }
});

app.post<{ Body: SalesOrderInput }>("/api/marinar/sales-orders", async (req, reply) => {
  try {
    // The order's lines come from the current delivery sheet, mapped to the
    // custom API's salesOrderLines shape (lineType / lineObjectNumber / quantity).
    const sheet = await listDeliverySheet();
    const lines = sheet.map((l) => ({
      lineType: "Item",
      lineObjectNumber: l.item_no,
      quantity: Number(l.quantity),
    }));
    const order = await createMarinarSalesOrder(await getSetup(), {
      customerNumber: (req.body?.customerNumber ?? "").trim(),
      shipToCode: req.body?.shipToCode?.trim() || undefined,
      deliveryType: req.body?.deliveryType?.trim() || undefined,
      orderDate: req.body?.orderDate?.trim() || undefined,
      lines,
    });
    return { order };
  } catch (err) {
    return reply.status(400).send({ error: describe(err) });
  }
});

// Fields (with enum members) for a Marinar entity — the order card + line grid.
app.get<{ Params: { entity: string } }>("/api/marinar/fields/:entity", async (req, reply) => {
  try {
    return { fields: await marinarFields(await getSetup(), req.params.entity) };
  } catch (err) {
    return reply.status(400).send({ error: describe(err) });
  }
});

// One full sales order (card view).
app.get<{ Params: { id: string } }>("/api/marinar/sales-orders/:id", async (req, reply) => {
  try {
    return { order: await getMarinarRecord(await getSetup(), "salesOrders", req.params.id) };
  } catch (err) {
    return reply.status(400).send({ error: describe(err) });
  }
});

// PATCH the sales order header with only the changed fields.
app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
  "/api/marinar/sales-orders/:id",
  async (req, reply) => {
    try {
      const order = await updateMarinarRecord(
        await getSetup(),
        "salesOrders",
        req.params.id,
        req.body ?? {},
      );
      return { order };
    } catch (err) {
      return reply.status(400).send({ error: describe(err) });
    }
  },
);

// DELETE the sales order.
app.delete<{ Params: { id: string } }>("/api/marinar/sales-orders/:id", async (req, reply) => {
  try {
    await deleteMarinarRecord(await getSetup(), "salesOrders", req.params.id);
    return { ok: true };
  } catch (err) {
    return reply.status(400).send({ error: describe(err) });
  }
});

// The order's lines (bottom grid).
app.get<{ Params: { id: string } }>(
  "/api/marinar/sales-orders/:id/lines",
  async (req, reply) => {
    try {
      return { lines: await marinarOrderLines(await getSetup(), req.params.id) };
    } catch (err) {
      return reply.status(400).send({ error: describe(err) });
    }
  },
);

// PATCH one sales order line with only the changed fields.
app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
  "/api/marinar/sales-order-lines/:id",
  async (req, reply) => {
    try {
      const line = await updateMarinarRecord(
        await getSetup(),
        "salesOrderLines",
        req.params.id,
        req.body ?? {},
      );
      return { line };
    } catch (err) {
      return reply.status(400).send({ error: describe(err) });
    }
  },
);

// --- Planning worksheet (Marinar planningOrders): create / patch / delete --
// The list itself is served by the generic live route (/api/live/planningOrders).

app.post<{ Body: Record<string, unknown> }>("/api/marinar/planning-orders", async (req, reply) => {
  try {
    const line = await createMarinarRecord(await getSetup(), "planningOrders", req.body ?? {});
    return { line };
  } catch (err) {
    return reply.status(400).send({ error: describe(err) });
  }
});

app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
  "/api/marinar/planning-orders/:id",
  async (req, reply) => {
    try {
      const line = await updateMarinarRecord(
        await getSetup(),
        "planningOrders",
        req.params.id,
        req.body ?? {},
      );
      return { line };
    } catch (err) {
      return reply.status(400).send({ error: describe(err) });
    }
  },
);

app.delete<{ Params: { id: string } }>(
  "/api/marinar/planning-orders/:id",
  async (req, reply) => {
    try {
      await deleteMarinarRecord(await getSetup(), "planningOrders", req.params.id);
      return { ok: true };
    } catch (err) {
      return reply.status(400).send({ error: describe(err) });
    }
  },
);

// --- Live entities: served directly from BC, no database ------------------

/** Which entities are live and what bound actions each exposes. */
app.get("/api/live-entities", async () => LIVE_ENTITIES);

/**
 * One page straight from BC (30/page, native paging). Optional OData query:
 *   ?select=a,b,c   -> $select
 *   ?filter=<expr>  -> $filter
 *   ?orderby=a desc -> $orderby   (comma-separates multiple clauses)
 */
app.get<{
  Params: { entity: string };
  Querystring: { next?: string; select?: string; filter?: string; orderby?: string };
}>("/api/live/:entity", async (req, reply) => {
  try {
    const csv = (v?: string) =>
      v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    return await listEntity(await getSetup(), req.params.entity, {
      next: req.query.next,
      select: csv(req.query.select),
      filter: req.query.filter,
      orderby: csv(req.query.orderby),
    });
  } catch (err) {
    return reply.status(400).send({ error: describe(err) });
  }
});

/** The scalar fields available on the entity (for the column/filter/sort UI). */
app.get<{ Params: { entity: string } }>("/api/live/:entity/fields", async (req, reply) => {
  try {
    return { fields: await entityFields(await getSetup(), req.params.entity) };
  } catch (err) {
    return reply.status(400).send({ error: describe(err) });
  }
});

/** The navigation (expand) properties available on the entity. */
app.get<{ Params: { entity: string } }>(
  "/api/live/:entity/nav-properties",
  async (req, reply) => {
    try {
      return { navProperties: await entityNavProperties(await getSetup(), req.params.entity) };
    } catch (err) {
      return reply.status(400).send({ error: describe(err) });
    }
  },
);

/** Drill down into one navigation property of a single record. */
app.get<{ Params: { entity: string; id: string; nav: string } }>(
  "/api/live/:entity/:id/navigation/:nav",
  async (req, reply) => {
    try {
      return await entityNavigation(
        await getSetup(),
        req.params.entity,
        req.params.id,
        req.params.nav,
      );
    } catch (err) {
      return reply.status(400).send({ error: describe(err) });
    }
  },
);

function actionParams(body: unknown): unknown {
  // An empty body (or {}) means the action takes no parameters.
  if (body == null) return undefined;
  if (typeof body === "object" && Object.keys(body as object).length === 0) return undefined;
  return body;
}

/** Example 1 — single entry, single mutation: run a bound action on one record. */
app.post<{ Params: { entity: string; id: string; action: string } }>(
  "/api/live/:entity/:id/actions/:action",
  async (req, reply) => {
    try {
      const outcome = await callEntityAction(
        await getSetup(),
        req.params.entity,
        req.params.id,
        req.params.action,
        actionParams(req.body),
      );
      return { outcome };
    } catch (err) {
      return reply.status(400).send({ error: describe(err) });
    }
  },
);

/** Example 2 — bulk execution: run a bound action on many records in one $batch. */
app.post<{ Params: { entity: string; action: string }; Body: { ids?: string[]; parameters?: unknown } }>(
  "/api/live/:entity/actions/:action",
  async (req, reply) => {
    try {
      const ids = req.body?.ids ?? [];
      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.status(400).send({ error: "Provide a non-empty 'ids' array." });
      }
      const outcomes = await bulkEntityAction(
        await getSetup(),
        req.params.entity,
        ids,
        req.params.action,
        actionParams(req.body?.parameters),
      );
      return { outcomes };
    } catch (err) {
      return reply.status(400).send({ error: describe(err) });
    }
  },
);

function describe(err: unknown): string {
  if (err instanceof SetupError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

const port = Number(process.env.PORT) || 3001;
await app.listen({ port, host: "0.0.0.0" });
