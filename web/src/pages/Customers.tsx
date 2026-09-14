import { useCallback, useEffect, useState } from "react";
import { api, type Customer } from "../api.js";

export function CustomersPage() {
  const [rows, setRows] = useState<Customer[]>([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (query: string) => {
    setLoading(true);
    setError(null);
    try {
      const { customers } = await api.getCustomers(query);
      setRows(customers);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load("");
  }, [load]);

  return (
    <section className="card">
      <div className="toolbar">
        <h2>Customers</h2>
        <div className="toolbar-right">
          <input
            placeholder="Search name, number, email…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load(q)}
          />
          <button onClick={() => load(q)} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="msg err">{error}</div>}

      {!error && rows.length === 0 && !loading && (
        <p className="hint">
          No customers yet. Configure the connection on the Setup tab and click
          “Pull customers”.
        </p>
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Number</th>
                <th>Name</th>
                <th>Email</th>
                <th>City</th>
                <th>Country</th>
                <th className="num">Balance</th>
                <th>Blocked</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{c.number}</td>
                  <td>{c.display_name}</td>
                  <td>{c.email}</td>
                  <td>{c.city}</td>
                  <td>{c.country}</td>
                  <td className="num">
                    {c.balance != null ? Number(c.balance).toLocaleString() : ""}
                  </td>
                  <td>{c.blocked && c.blocked.trim() ? c.blocked : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">{rows.length} row(s)</p>
        </div>
      )}
    </section>
  );
}
