import { useCallback, useEffect, useRef, useState } from "react";
import { api, type DeliveryLine, type Rec } from "../api.js";

export function DeliverySheet() {
  const [lines, setLines] = useState<DeliveryLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showOrder, setShowOrder] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { lines } = await api.getDeliverySheet();
      setLines(lines);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(id: string) {
    await api.deleteDeliveryLine(id);
    load();
  }

  return (
    <section className="card">
      <div className="toolbar">
        <div>
          <h2>Delivery Sheet</h2>
          <p className="hint" style={{ margin: 0 }}>
            Lines are stored in Postgres (<code>delivery_sheet</code>). Add items from BC,
            then create a sales order.
          </p>
        </div>
        <div className="toolbar-right">
          <button className="primary" onClick={() => setShowAdd(true)}>
            + Add item
          </button>
          <button className="primary" onClick={() => setShowOrder(true)}>
            Create sales order
          </button>
        </div>
      </div>

      {error && <div className="msg err">{error}</div>}
      {loading && <p className="hint">Loading…</p>}

      {!loading && lines.length === 0 && (
        <p className="hint">No lines yet. Click “Add item” to look one up from Business Central.</p>
      )}

      {lines.length > 0 && (
        <div className="table-wrap">
          <table className="dense">
            <thead>
              <tr>
                <th className="num">Line no</th>
                <th>Item no</th>
                <th className="num">Quantity</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className="num">{l.line_no}</td>
                  <td>{l.item_no}</td>
                  <td className="num">{Number(l.quantity).toFixed(2)}</td>
                  <td className="num">
                    <button className="link-danger" onClick={() => remove(l.id)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">{lines.length} line(s)</p>
        </div>
      )}

      {showAdd && (
        <AddItemModal
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            load();
          }}
        />
      )}

      {showOrder && <CreateSalesOrderModal onClose={() => setShowOrder(false)} />}
    </section>
  );
}

function AddItemModal(props: { onClose: () => void; onAdded: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Rec[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Rec | null>(null);
  const [quantity, setQuantity] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced live lookup against BC as the user types an item number.
  useEffect(() => {
    if (selected) return;
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length === 0) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        const page = await api.lookupItems(q.trim());
        setResults(page.items.slice(0, 20));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q, selected]);

  async function submit() {
    const number = String(selected?.number ?? "");
    const qty = Number(quantity);
    if (!number) return;
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Enter a quantity greater than 0.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.addDeliveryLine(number, qty);
      props.onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="modal-scrim" onClick={props.onClose} />
      <div className="modal" role="dialog" aria-label="Add item">
        <div className="modal-head">
          <h3>Add item</h3>
          <button className="icon" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {!selected ? (
          <>
            <label className="field">
              <span>Item number (live lookup from Business Central)</span>
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Type an item number, e.g. 1.100…"
              />
            </label>
            {searching && <p className="hint">Searching…</p>}
            {error && <div className="msg err">{error}</div>}
            {results.length > 0 && (
              <ul className="lookup-list">
                {results.map((r) => (
                  <li key={String(r.id)}>
                    <button onClick={() => setSelected(r)}>
                      <strong>{String(r.number ?? "")}</strong>
                      <span>{String(r.displayName ?? "")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!searching && q.trim() && results.length === 0 && !error && (
              <p className="hint">No items match “{q}”.</p>
            )}
          </>
        ) : (
          <>
            <div className="selected-item">
              <div>
                <strong>{String(selected.number ?? "")}</strong>
                <span>{String(selected.displayName ?? "")}</span>
              </div>
              <button className="link" onClick={() => setSelected(null)}>
                Change
              </button>
            </div>
            <label className="field">
              <span>Quantity</span>
              <input
                autoFocus
                type="number"
                min="0"
                step="0.01"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="0.00"
              />
            </label>
            {error && <div className="msg err">{error}</div>}
            <div className="modal-actions">
              <button onClick={props.onClose}>Cancel</button>
              <button className="primary" onClick={submit} disabled={submitting}>
                {submitting ? "Adding…" : "Add to sheet"}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function CreateSalesOrderModal(props: { onClose: () => void }) {
  // Field 1 — customer lookup
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Rec[]>([]);
  const [searching, setSearching] = useState(false);
  const [customer, setCustomer] = useState<Rec | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Field 2 — ship-to (pre-filtered by the chosen customer)
  const [shipTos, setShipTos] = useState<Rec[]>([]);
  const [shipToCode, setShipToCode] = useState("");
  const [shipToLoading, setShipToLoading] = useState(false);

  // Field 3 — delivery type (BC enum)
  const [deliveryTypes, setDeliveryTypes] = useState<string[]>([]);
  const [deliveryType, setDeliveryType] = useState("");

  // Field 4 — order date
  const [orderDate, setOrderDate] = useState(() => new Date().toISOString().slice(0, 10));

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Delivery types once.
  useEffect(() => {
    api
      .marinarDeliveryTypes()
      .then((r) => setDeliveryTypes(r.deliveryTypes))
      .catch((e) => setError((e as Error).message));
  }, []);

  // Debounced customer search.
  useEffect(() => {
    if (customer) return;
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length === 0) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        const { customers } = await api.marinarCustomers(q.trim());
        setResults(customers);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q, customer]);

  // Load ship-to addresses when a customer is chosen.
  useEffect(() => {
    if (!customer) return;
    setShipToLoading(true);
    setShipToCode("");
    api
      .marinarShipTo(String(customer.number ?? ""))
      .then((r) => setShipTos(r.shipToAddresses))
      .catch((e) => setError((e as Error).message))
      .finally(() => setShipToLoading(false));
  }, [customer]);

  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit() {
    const customerNumber = String(customer?.number ?? "");
    if (!customerNumber) {
      setResult({ ok: false, text: "Select a customer." });
      return;
    }
    setSubmitting(true);
    setResult(null);
    setError(null);
    try {
      const { order } = await api.createSalesOrder({
        customerNumber,
        shipToCode: shipToCode || undefined,
        deliveryType: deliveryType || undefined,
        orderDate: orderDate || undefined,
      });
      const number = String(order.number ?? order.id ?? "");
      setResult({ ok: true, text: `Sales order ${number} created.` });
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="modal-scrim" onClick={props.onClose} />
      <div className="modal" role="dialog" aria-label="Create sales order">
        <div className="modal-head">
          <h3>Create sales order</h3>
          <button className="icon" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {/* 1 — Customer */}
        <label className="field">
          <span>Customer</span>
          {customer ? (
            <div className="selected-item">
              <div>
                <strong>{String(customer.number ?? "")}</strong>
                <span>{String(customer.displayName ?? "")}</span>
              </div>
              <button className="link" onClick={() => setCustomer(null)}>
                Change
              </button>
            </div>
          ) : (
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by customer number, or name (case-sensitive)"
            />
          )}
        </label>
        {!customer && searching && <p className="hint">Searching…</p>}
        {!customer && results.length > 0 && (
          <ul className="lookup-list">
            {results.map((r) => (
              <li key={String(r.id)}>
                <button onClick={() => setCustomer(r)}>
                  <strong>{String(r.number ?? "")}</strong>
                  <span>{String(r.displayName ?? "")}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* 2 — Ship-to (pre-filtered by customerNumber) */}
        <label className="field">
          <span>Ship-to address</span>
          <select
            value={shipToCode}
            onChange={(e) => setShipToCode(e.target.value)}
            disabled={!customer || shipToLoading}
          >
            <option value="">
              {!customer
                ? "Select a customer first"
                : shipToLoading
                  ? "Loading…"
                  : shipTos.length === 0
                    ? "No ship-to addresses"
                    : "— select —"}
            </option>
            {shipTos.map((s) => (
              <option key={String(s.code)} value={String(s.code)}>
                {String(s.code)} — {String(s.displayName ?? "")}
              </option>
            ))}
          </select>
        </label>

        {/* 3 — Delivery type (BC enum) */}
        <label className="field">
          <span>Delivery type</span>
          <select value={deliveryType} onChange={(e) => setDeliveryType(e.target.value)}>
            <option value="">— select —</option>
            {deliveryTypes.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>

        {/* 4 — Order date */}
        <label className="field">
          <span>Order date</span>
          <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
        </label>

        {error && <div className="msg err">{error}</div>}
        {result && <div className={`msg ${result.ok ? "ok" : "err"}`}>{result.text}</div>}

        <div className="modal-actions">
          <button onClick={props.onClose}>{result?.ok ? "Close" : "Cancel"}</button>
          <button
            className="primary"
            onClick={submit}
            disabled={submitting || !customer || result?.ok}
          >
            {submitting ? "Creating…" : result?.ok ? "Created" : "Create order"}
          </button>
        </div>
      </div>
    </>
  );
}
