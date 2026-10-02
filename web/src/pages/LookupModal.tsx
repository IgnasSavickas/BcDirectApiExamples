import { useEffect, useState } from "react";
import { api, type Rec } from "../api.js";
import { fmt } from "./fieldEditing.js";

export interface LookupConfig {
  title: string;
  /** Live entity to list (must be allow-listed in LIVE_ENTITIES). */
  entity: string;
  select: string[];
  orderby?: string[];
  /** Field shown bold as the record's key; the rest of `columns` follow it. */
  keyField: string;
  columns: string[];
  /**
   * Builds a server-side $filter for the search text. When omitted, the loaded
   * rows are filtered in the browser (fine for small lists).
   */
  searchFilter?: (q: string) => string;
}

const esc = (v: string) => v.replace(/'/g, "''");

/** Standard BC items: digits search the number, anything else the name (BC rejects OR across fields). */
export const ITEM_LOOKUP: LookupConfig = {
  title: "Items",
  entity: "items",
  select: ["number", "displayName", "baseUnitOfMeasureCode"],
  orderby: ["number"],
  keyField: "number",
  columns: ["displayName", "baseUnitOfMeasureCode"],
  searchFilter: (q) =>
    /^\d/.test(q) ? `contains(number,'${esc(q)}')` : `contains(displayName,'${esc(q)}')`,
};

export const LOCATION_LOOKUP: LookupConfig = {
  title: "Locations",
  entity: "locations",
  select: ["code", "displayName", "city"],
  orderby: ["code"],
  keyField: "code",
  columns: ["displayName", "city"],
};

/**
 * Drill-down dialog over a live BC list: search, scroll, "Load more", and pick
 * a record. `isSelected` highlights the current value; `clearLabel` adds a
 * first entry that picks `null` (e.g. "no filter").
 */
export function LookupModal(props: {
  config: LookupConfig;
  isSelected?: (row: Rec) => boolean;
  clearLabel?: string;
  onPick: (row: Rec | null) => void;
  onClose: () => void;
}) {
  const { config } = props;
  const [rows, setRows] = useState<Rec[]>([]);
  const [nextLink, setNextLink] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const term = q.trim();
  const serverTerm = config.searchFilter ? term : "";

  async function load(token?: string) {
    setLoading(true);
    setError(null);
    try {
      const page = await api.getLive(config.entity, {
        next: token,
        select: config.select,
        orderby: config.orderby,
        filter: serverTerm && config.searchFilter ? config.searchFilter(serverTerm) : undefined,
      });
      setRows((r) => (token ? [...r, ...page.items] : page.items));
      setNextLink(page.nextLink);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // (Re)load on open and, for server-side search, as the user types (debounced).
  useEffect(() => {
    const t = setTimeout(() => load(), serverTerm ? 300 : 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, serverTerm]);

  const lower = term.toLowerCase();
  const shown =
    config.searchFilter || !lower
      ? rows
      : rows.filter((r) =>
          [config.keyField, ...config.columns].some((c) => fmt(r[c]).toLowerCase().includes(lower)),
        );

  return (
    <>
      <div className="modal-scrim" onClick={props.onClose} />
      <div className="modal" role="dialog" aria-label={config.title}>
        <div className="modal-head">
          <h3>{config.title}</h3>
          <button className="icon" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          style={{ width: "100%" }}
        />
        {error && <div className="msg err">{error}</div>}
        <ul className="lookup-list">
          {props.clearLabel && (
            <li>
              <button onClick={() => props.onPick(null)}>
                <strong>(all)</strong>
                <span>{props.clearLabel}</span>
              </button>
            </li>
          )}
          {shown.map((r, i) => (
            <li key={fmt(r.id) || i}>
              <button
                className={props.isSelected?.(r) ? "picked" : ""}
                onClick={() => props.onPick(r)}
              >
                <strong>{fmt(r[config.keyField])}</strong>
                <span>
                  {config.columns
                    .map((c) => fmt(r[c]))
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {loading && <p className="hint">Loading…</p>}
        {!loading && shown.length === 0 && !error && <p className="hint">No matches.</p>}
        {!loading && nextLink && (
          <div className="modal-actions">
            <button onClick={() => load(nextLink)}>Load more</button>
          </div>
        )}
      </div>
    </>
  );
}
