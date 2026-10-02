import { useCallback, useEffect, useState } from "react";
import { api, type EntityField, type Rec } from "../api.js";
import { LiveEntity } from "./LiveEntity.js";

// --- Shared field-editing helpers -----------------------------------------

const READONLY = new Set(["id", "documentId", "lastModifiedDateTime"]);

const isBool = (t: string) => /Boolean/i.test(t);
const isNum = (t: string) => /Int|Decimal|Double|Single/i.test(t);
const isDate = (t: string) => /\.Date$/i.test(t) || /Edm\.Date$/i.test(t);
const isDateTime = (t: string) => /DateTimeOffset/i.test(t);

function fmt(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Converts an edited string back to the proper type for the PATCH body. */
function coerce(type: string, s: string): unknown {
  if (isBool(type)) return s === "true";
  if (isNum(type)) return s.trim() === "" ? null : Number(s);
  return s; // string / guid / date / enum
}

function FieldInput(props: {
  field: EntityField;
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  const { field, value, disabled, onChange } = props;
  const common = { value, disabled, onChange: (e: { target: { value: string } }) => onChange(e.target.value) };

  if (field.enumMembers && field.enumMembers.length > 0) {
    return (
      <select {...common}>
        {!field.enumMembers.includes(value) && <option value={value}>{value || "—"}</option>}
        {field.enumMembers.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    );
  }
  if (isBool(field.type)) {
    return (
      <select {...common}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (isDate(field.type)) return <input type="date" {...common} />;
  if (isNum(field.type)) return <input type="number" step="any" {...common} />;
  return <input type={isDateTime(field.type) ? "text" : "text"} {...common} />;
}

// --- Page: list <-> card ---------------------------------------------------

export function SalesOrders() {
  const [openId, setOpenId] = useState<string | null>(null);

  if (openId) {
    return <SalesOrderCard id={openId} onBack={() => setOpenId(null)} />;
  }
  return (
    <LiveEntity
      entity="salesOrders"
      title="Sales Orders — live from Business Central"
      subtitle="Direct fields only, 30 per page (native BC paging). Click a row to open the order card."
      onOpen={(row) => setOpenId(String(row.id))}
    />
  );
}

// --- Order card (header) ---------------------------------------------------

function SalesOrderCard(props: { id: string; onBack: () => void }) {
  const { id, onBack } = props;
  const [order, setOrder] = useState<Rec | null>(null);
  const [fields, setFields] = useState<EntityField[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [o, f] = await Promise.all([
        api.getSalesOrder(id),
        api.marinarFields("salesOrders"),
      ]);
      setOrder(o.order);
      setFields(f.fields);
      setEdits({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const orig = (name: string) => fmt(order?.[name]);
  const current = (name: string) => (name in edits ? edits[name] : orig(name));
  const dirty = fields.filter((f) => f.name in edits && edits[f.name] !== orig(f.name));

  function setField(name: string, v: string) {
    setResult(null);
    setEdits((e) => ({ ...e, [name]: v }));
  }

  async function submit() {
    if (dirty.length === 0) return;
    const patch: Record<string, unknown> = {};
    for (const f of dirty) patch[f.name] = coerce(f.type, edits[f.name]);
    setSaving(true);
    setResult(null);
    try {
      const { order } = await api.patchSalesOrder(id, patch);
      setOrder(order);
      setEdits({});
      setResult({ ok: true, text: `Saved ${dirty.length} change(s).` });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function doDelete() {
    setDeleting(true);
    setResult(null);
    try {
      await api.deleteSalesOrder(id);
      onBack();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const title = order ? `Sales Order ${fmt(order.number)}` : "Sales Order";

  return (
    <section className="card">
      <div className="card-head">
        <div className="card-head-left">
          <button onClick={onBack}>‹ Back</button>
          <h2>{title}</h2>
          {dirty.length > 0 && <span className="dirty-badge">{dirty.length} unsaved</span>}
        </div>
        <div className="card-head-right">
          <button className="primary" onClick={submit} disabled={saving || dirty.length === 0}>
            {saving ? "Submitting…" : "Submit changes"}
          </button>
          {!confirmDelete ? (
            <button className="danger" onClick={() => setConfirmDelete(true)} disabled={deleting}>
              Delete order
            </button>
          ) : (
            <>
              <button className="danger" onClick={doDelete} disabled={deleting}>
                {deleting ? "Deleting…" : "Confirm delete"}
              </button>
              <button onClick={() => setConfirmDelete(false)} disabled={deleting}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>

      {error && <div className="msg err">{error}</div>}
      {result && <div className={`msg ${result.ok ? "ok" : "err"}`}>{result.text}</div>}
      {loading && <p className="hint">Loading…</p>}

      {order && (
        <>
          <h4>Header fields</h4>
          <div className="field-grid">
            {fields.map((f) => {
              const ro = READONLY.has(f.name);
              const isDirty = f.name in edits && edits[f.name] !== orig(f.name);
              return (
                <label key={f.name} className={`fg-item${isDirty ? " dirty" : ""}`}>
                  <span>
                    {f.name}
                    <em>{f.type.replace("Microsoft.NAV.", "").replace("Edm.", "")}</em>
                  </span>
                  <FieldInput
                    field={f}
                    value={current(f.name)}
                    disabled={ro}
                    onChange={(v) => setField(f.name, v)}
                  />
                </label>
              );
            })}
          </div>

          <SalesOrderLines orderId={id} />
        </>
      )}
    </section>
  );
}

// --- Lines grid (inline editable) -----------------------------------------

function SalesOrderLines({ orderId }: { orderId: string }) {
  const [lines, setLines] = useState<Rec[]>([]);
  const [fields, setFields] = useState<EntityField[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  // edits keyed by line id -> field -> new string value
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [l, f] = await Promise.all([
        api.getSalesOrderLines(orderId),
        api.marinarFields("salesOrderLines"),
      ]);
      setLines(l.lines);
      setFields(f.fields);
      setEdits({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    load();
  }, [load]);

  const orig = (line: Rec, name: string) => fmt(line[name]);
  const current = (line: Rec, name: string) => {
    const lid = String(line.id);
    return edits[lid] && name in edits[lid] ? edits[lid][name] : orig(line, name);
  };
  function setCell(lineId: string, name: string, v: string) {
    setResult(null);
    setEdits((e) => ({ ...e, [lineId]: { ...(e[lineId] ?? {}), [name]: v } }));
  }

  // which lines have at least one field that differs from the original
  const dirtyLineIds = lines
    .filter((line) => {
      const lid = String(line.id);
      const e = edits[lid];
      return e && Object.keys(e).some((name) => e[name] !== orig(line, name));
    })
    .map((l) => String(l.id));

  async function submit() {
    if (dirtyLineIds.length === 0) return;
    setSaving(true);
    setResult(null);
    let ok = 0;
    const failures: string[] = [];
    for (const line of lines) {
      const lid = String(line.id);
      if (!dirtyLineIds.includes(lid)) continue;
      const e = edits[lid];
      const patch: Record<string, unknown> = {};
      for (const name of Object.keys(e)) {
        if (e[name] !== orig(line, name)) {
          const field = fields.find((f) => f.name === name);
          patch[name] = coerce(field?.type ?? "Edm.String", e[name]);
        }
      }
      try {
        await api.patchSalesOrderLine(lid, patch);
        ok++;
      } catch (err) {
        failures.push(`${fmt(line.lineObjectNumber) || lid.slice(0, 8)}: ${(err as Error).message}`);
      }
    }
    setSaving(false);
    setResult(
      failures.length === 0
        ? { ok: true, text: `Saved ${ok} line(s).` }
        : { ok: false, text: `${ok} saved, ${failures.length} failed — ${failures[0]}` },
    );
    load();
  }

  return (
    <div className="lines-section">
      <div className="lines-head">
        <h4>Sales order lines</h4>
        <button className="primary" onClick={submit} disabled={saving || dirtyLineIds.length === 0}>
          {saving ? "Submitting…" : `Submit line changes${dirtyLineIds.length ? ` (${dirtyLineIds.length})` : ""}`}
        </button>
      </div>

      {error && <div className="msg err">{error}</div>}
      {result && <div className={`msg ${result.ok ? "ok" : "err"}`}>{result.text}</div>}
      {loading && <p className="hint">Loading lines…</p>}

      {!loading && lines.length === 0 && <p className="hint">This order has no lines.</p>}

      {lines.length > 0 && (
        <div className="table-wrap">
          <table className="dense grid-edit">
            <thead>
              <tr>
                {fields.map((f) => (
                  <th key={f.name}>{f.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => {
                const lid = String(line.id);
                return (
                  <tr key={lid} className={dirtyLineIds.includes(lid) ? "row-dirty" : ""}>
                    {fields.map((f) => {
                      const ro = READONLY.has(f.name);
                      const isDirty =
                        edits[lid] && f.name in edits[lid] && edits[lid][f.name] !== orig(line, f.name);
                      return (
                        <td key={f.name} className={isDirty ? "cell-dirty" : ""}>
                          <FieldInput
                            field={f}
                            value={current(line, f.name)}
                            disabled={ro}
                            onChange={(v) => setCell(lid, f.name, v)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
