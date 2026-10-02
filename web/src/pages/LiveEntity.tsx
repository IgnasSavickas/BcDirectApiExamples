import { useCallback, useEffect, useState } from "react";
import {
  api,
  type ActionOutcome,
  type EntityField,
  type LiveQuery,
  type NavigationResult,
  type Rec,
} from "../api.js";

const HIDDEN_COLS = new Set(["@odata.etag"]);

function fmt(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function columnsOf(rows: Rec[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!HIDDEN_COLS.has(k) && !seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

// --- OData query helpers ---------------------------------------------------

type Sort = { field: string; dir: "asc" | "desc" } | null;
type FilterClause = { field: string; op: string; value: string };

const STRING_OPS: [string, string][] = [
  ["eq", "="],
  ["ne", "≠"],
  ["contains", "contains"],
  ["startswith", "starts with"],
  ["endswith", "ends with"],
];
const SCALAR_OPS: [string, string][] = [
  ["eq", "="],
  ["ne", "≠"],
  ["gt", ">"],
  ["ge", "≥"],
  ["lt", "<"],
  ["le", "≤"],
];

const isString = (t: string) => /String|Guid/i.test(t);
const isBool = (t: string) => /Boolean/i.test(t);
const isNumber = (t: string) => /Int|Decimal|Double|Single/i.test(t);
const isDate = (t: string) => /Date|Time/i.test(t);

const opsForType = (t: string) => (isString(t) ? STRING_OPS : SCALAR_OPS);

function typeOf(field: string, fields: EntityField[]): string {
  return fields.find((f) => f.name === field)?.type ?? "Edm.String";
}

/** Formats a value as an OData literal for its field's type. */
function formatValue(field: string, value: string, fields: EntityField[]): string {
  const t = typeOf(field, fields);
  if (isBool(t)) return /^true$/i.test(value.trim()) ? "true" : "false";
  if (isNumber(t)) return value.trim() === "" ? "0" : value.trim();
  if (isDate(t)) return value.trim(); // user enters an ISO literal
  return `'${value.replace(/'/g, "''")}'`; // string / guid
}

function clauseToOData(c: FilterClause, fields: EntityField[]): string {
  const v = formatValue(c.field, c.value, fields);
  if (c.op === "contains" || c.op === "startswith" || c.op === "endswith") {
    return `${c.op}(${c.field},${v})`;
  }
  return `${c.field} ${c.op} ${v}`;
}

function buildFilter(clauses: FilterClause[], fields: EntityField[]): string | undefined {
  if (clauses.length === 0) return undefined;
  return clauses.map((c) => clauseToOData(c, fields)).join(" and ");
}

function buildQuery(
  visible: Set<string>,
  filters: FilterClause[],
  sort: Sort,
  fields: EntityField[],
): LiveQuery {
  return {
    select: visible.size ? [...visible] : undefined,
    filter: buildFilter(filters, fields),
    orderby: sort ? [`${sort.field} ${sort.dir}`] : undefined,
  };
}

// --- Component -------------------------------------------------------------

export interface ActionConfig {
  name: string;
  label: string;
}

export interface LiveEntityProps {
  entity: string;
  title: string;
  subtitle?: string;
  actions?: ActionConfig[];
  /** When set, clicking a row calls this instead of opening the drill-down drawer. */
  onOpen?: (row: Rec) => void;
}

export function LiveEntity({ entity, title, subtitle, actions = [], onOpen }: LiveEntityProps) {
  const hasActions = actions.length > 0;

  const [rows, setRows] = useState<Rec[]>([]);
  const [nextLink, setNextLink] = useState<string | undefined>();
  const [stack, setStack] = useState<(string | undefined)[]>([undefined]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Rec | null>(null);

  // schema + query state
  const [fields, setFields] = useState<EntityField[]>([]);
  const [navProps, setNavProps] = useState<string[]>([]);
  const [visibleCols, setVisibleCols] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<FilterClause[]>([]);
  const [sort, setSort] = useState<Sort>(null);
  const [activeQuery, setActiveQuery] = useState<LiveQuery>({});
  const [showCols, setShowCols] = useState(false);
  const [showFilter, setShowFilter] = useState(false);

  // bulk actions
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [outcomes, setOutcomes] = useState<{ action: string; results: ActionOutcome[] } | null>(
    null,
  );

  const loadPage = useCallback(
    async (token: string | undefined, q: LiveQuery) => {
      setLoading(true);
      setError(null);
      setChecked(new Set());
      try {
        const page = await api.getLive(entity, { ...q, next: token });
        setRows(page.items);
        setNextLink(page.nextLink);
      } catch (e) {
        setError((e as Error).message);
        setRows([]);
        setNextLink(undefined);
      } finally {
        setLoading(false);
      }
    },
    [entity],
  );

  /** Reset to page 1 and load with a new query. */
  const reload = useCallback(
    (q: LiveQuery) => {
      setActiveQuery(q);
      setStack([undefined]);
      setIdx(0);
      setSelected(null);
      setOutcomes(null);
      loadPage(undefined, q);
    },
    [loadPage],
  );

  // Load schema + first page when the entity changes.
  useEffect(() => {
    let cancelled = false;
    setFilters([]);
    setSort(null);
    setShowCols(false);
    setShowFilter(false);
    (async () => {
      try {
        const [f, nav] = await Promise.all([
          api.getLiveFields(entity),
          api.getLiveNavProps(entity),
        ]);
        if (cancelled) return;
        setFields(f.fields);
        setNavProps(nav.navProperties);
        const vis = new Set(f.fields.map((x) => x.name));
        setVisibleCols(vis);
        reload(buildQuery(vis, [], null, f.fields));
      } catch {
        if (cancelled) return;
        setFields([]);
        setNavProps([]);
        setVisibleCols(new Set());
        reload({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entity, reload]);

  const next = () => {
    if (!nextLink) return;
    const newStack = stack.slice(0, idx + 1);
    newStack.push(nextLink);
    setStack(newStack);
    setIdx(idx + 1);
    loadPage(nextLink, activeQuery);
  };
  const prev = () => {
    if (idx === 0) return;
    setIdx(idx - 1);
    loadPage(stack[idx - 1], activeQuery);
  };

  const toggleCol = (name: string) => {
    const nv = new Set(visibleCols);
    if (nv.has(name)) nv.delete(name);
    else nv.add(name);
    if (nv.size === 0) return; // keep at least one column
    setVisibleCols(nv);
    reload(buildQuery(nv, filters, sort, fields));
  };
  const setAllCols = (on: boolean) => {
    const nv = on ? new Set(fields.map((f) => f.name)) : new Set([fields[0]?.name].filter(Boolean));
    setVisibleCols(nv);
    reload(buildQuery(nv, filters, sort, fields));
  };

  const cycleSort = (field: string) => {
    let ns: Sort;
    if (!sort || sort.field !== field) ns = { field, dir: "asc" };
    else if (sort.dir === "asc") ns = { field, dir: "desc" };
    else ns = null;
    setSort(ns);
    reload(buildQuery(visibleCols, filters, ns, fields));
  };

  const addFilter = (c: FilterClause) => {
    const nf = [...filters, c];
    setFilters(nf);
    reload(buildQuery(visibleCols, nf, sort, fields));
  };
  const removeFilter = (i: number) => {
    const nf = filters.filter((_, j) => j !== i);
    setFilters(nf);
    reload(buildQuery(visibleCols, nf, sort, fields));
  };

  const cols =
    fields.length > 0
      ? fields.filter((f) => visibleCols.has(f.name)).map((f) => f.name)
      : columnsOf(rows);

  const pageIds = rows.map((r) => fmt(r.id)).filter(Boolean);
  const allChecked = pageIds.length > 0 && pageIds.every((id) => checked.has(id));
  const toggle = (id: string) => {
    const nextSet = new Set(checked);
    if (nextSet.has(id)) nextSet.delete(id);
    else nextSet.add(id);
    setChecked(nextSet);
  };
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(pageIds));

  async function runBulk(action: ActionConfig) {
    const ids = [...checked];
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Run “${action.label}” on ${ids.length} record(s)?\n\n` +
          `This posts documents in Business Central and cannot be undone.`,
      )
    )
      return;
    setRunning(true);
    setOutcomes(null);
    setError(null);
    try {
      const res = await api.runBulkAction(entity, action.name, ids);
      setOutcomes({ action: action.label, results: res.outcomes });
      await loadPage(stack[idx], activeQuery);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="card">
      <div className="toolbar">
        <div>
          <h2>{title}</h2>
          <p className="hint" style={{ margin: 0 }}>
            {subtitle ?? "Direct fields only, 30 per page (native BC paging)."} Click a row
            to drill into its expand properties.
          </p>
        </div>
        <div className="toolbar-right">
          <div className="menu-wrap">
            <button className={showCols ? "active-btn" : ""} onClick={() => setShowCols((v) => !v)}>
              Columns ({visibleCols.size}/{fields.length || "…"})
            </button>
            {showCols && (
              <ColumnsMenu
                fields={fields}
                visible={visibleCols}
                onToggle={toggleCol}
                onAll={() => setAllCols(true)}
                onNone={() => setAllCols(false)}
                onClose={() => setShowCols(false)}
              />
            )}
          </div>
          <div className="menu-wrap">
            <button
              className={showFilter ? "active-btn" : ""}
              onClick={() => setShowFilter((v) => !v)}
            >
              Filter {filters.length > 0 ? `(${filters.length})` : ""}
            </button>
            {showFilter && (
              <FilterMenu fields={fields} onAdd={addFilter} onClose={() => setShowFilter(false)} />
            )}
          </div>
          <button onClick={prev} disabled={loading || idx === 0}>
            ‹ Prev
          </button>
          <span className="page-badge">Page {idx + 1}</span>
          <button onClick={next} disabled={loading || !nextLink}>
            Next ›
          </button>
        </div>
      </div>

      {(filters.length > 0 || sort) && (
        <div className="query-chips">
          {sort && (
            <span className="qchip sort">
              sort: {sort.field} {sort.dir}
              <button onClick={() => cycleSort(sort.field)} aria-label="clear sort">
                ✕
              </button>
            </span>
          )}
          {filters.map((c, i) => (
            <span className="qchip" key={i}>
              {c.field} {opLabel(c.op)} {c.value}
              <button onClick={() => removeFilter(i)} aria-label="remove filter">
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {hasActions && checked.size > 0 && (
        <div className="bulk-bar">
          <span>
            <strong>{checked.size}</strong> selected
          </span>
          <span className="bulk-tag">bulk execution</span>
          {actions.map((a) => (
            <button key={a.name} className="danger" disabled={running} onClick={() => runBulk(a)}>
              {running ? "Running…" : a.label}
            </button>
          ))}
          <button onClick={() => setChecked(new Set())} disabled={running}>
            Clear
          </button>
        </div>
      )}

      {error && <div className="msg err">{error}</div>}
      {loading && <p className="hint">Loading…</p>}
      {outcomes && <OutcomesPanel action={outcomes.action} results={outcomes.results} />}

      {!loading && rows.length === 0 && !error && <p className="hint">No records match.</p>}

      {!loading && rows.length > 0 && (
        <div className="table-wrap">
          <table className="dense">
            <thead>
              <tr>
                {hasActions && (
                  <th className="check">
                    <input type="checkbox" checked={allChecked} onChange={toggleAll} />
                  </th>
                )}
                {cols.map((c) => (
                  <th key={c} className="sortable" onClick={() => cycleSort(c)}>
                    {c}
                    {sort?.field === c ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const id = fmt(r.id);
                return (
                  <tr
                    key={id || i}
                    className="clickable"
                    onClick={() => (onOpen ? onOpen(r) : setSelected(r))}
                  >
                    {hasActions && (
                      <td className="check" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={checked.has(id)}
                          onChange={() => toggle(id)}
                        />
                      </td>
                    )}
                    {cols.map((c) => (
                      <td key={c} title={fmt(r[c])}>
                        {fmt(r[c])}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <RecordDrawer
          entity={entity}
          item={selected}
          navProps={navProps}
          actions={actions}
          onClose={() => setSelected(null)}
          onActed={() => loadPage(stack[idx], activeQuery)}
        />
      )}
    </section>
  );
}

function opLabel(op: string): string {
  const all = [...STRING_OPS, ...SCALAR_OPS];
  return all.find(([v]) => v === op)?.[1] ?? op;
}

function ColumnsMenu(props: {
  fields: EntityField[];
  visible: Set<string>;
  onToggle: (name: string) => void;
  onAll: () => void;
  onNone: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="menu-scrim" onClick={props.onClose} />
      <div className="menu">
        <div className="menu-head">
          <strong>Columns ($select)</strong>
          <span>
            <button className="link" onClick={props.onAll}>
              All
            </button>
            <button className="link" onClick={props.onNone}>
              None
            </button>
          </span>
        </div>
        <div className="menu-list">
          {props.fields.map((f) => (
            <label key={f.name} className="menu-item">
              <input
                type="checkbox"
                checked={props.visible.has(f.name)}
                onChange={() => props.onToggle(f.name)}
              />
              <span>{f.name}</span>
              <em>{f.type.replace("Edm.", "")}</em>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

function FilterMenu(props: {
  fields: EntityField[];
  onAdd: (c: FilterClause) => void;
  onClose: () => void;
}) {
  const [field, setField] = useState(props.fields[0]?.name ?? "");
  const type = props.fields.find((f) => f.name === field)?.type ?? "Edm.String";
  const ops = opsForType(type);
  const [op, setOp] = useState(ops[0][0]);
  const [value, setValue] = useState("");

  function onFieldChange(name: string) {
    setField(name);
    const t = props.fields.find((f) => f.name === name)?.type ?? "Edm.String";
    setOp(opsForType(t)[0][0]);
  }

  function submit() {
    if (!field) return;
    props.onAdd({ field, op, value });
    setValue("");
  }

  return (
    <>
      <div className="menu-scrim" onClick={props.onClose} />
      <div className="menu filter-menu">
        <div className="menu-head">
          <strong>Add filter ($filter)</strong>
        </div>
        <div className="filter-row">
          <select value={field} onChange={(e) => onFieldChange(e.target.value)}>
            {props.fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
          <select value={op} onChange={(e) => setOp(e.target.value)}>
            {ops.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={isNumber(type) ? "number" : isBool(type) ? "true / false" : "value"}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <div className="filter-actions">
          <button className="primary" onClick={submit}>
            Add filter
          </button>
        </div>
      </div>
    </>
  );
}

function OutcomesPanel(props: { action: string; results: ActionOutcome[] }) {
  const ok = props.results.filter((r) => r.ok).length;
  const failed = props.results.length - ok;
  return (
    <div className={`msg ${failed === 0 ? "ok" : "err"}`}>
      <strong>
        {props.action}: {ok} succeeded, {failed} failed
      </strong>
      {failed > 0 && (
        <ul className="outcome-list">
          {props.results
            .filter((r) => !r.ok)
            .map((r) => (
              <li key={r.id}>
                <code>{r.id.slice(0, 8)}…</code> {r.error}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

function RecordDrawer(props: {
  entity: string;
  item: Rec;
  navProps: string[];
  actions: ActionConfig[];
  onClose: () => void;
  onActed: () => void;
}) {
  const { entity, item, navProps, actions, onClose, onActed } = props;
  const id = fmt(item.id);
  const title = fmt(item.displayName) || fmt(item.number) || "Record";

  const [active, setActive] = useState<string | null>(null);
  const [result, setResult] = useState<NavigationResult | null>(null);
  const [navLoading, setNavLoading] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);

  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionOutcome, setActionOutcome] = useState<ActionOutcome | null>(null);

  async function drill(nav: string) {
    setActive(nav);
    setResult(null);
    setNavError(null);
    setNavLoading(true);
    try {
      setResult(await api.getLiveNavigation(entity, id, nav));
    } catch (e) {
      setNavError((e as Error).message);
    } finally {
      setNavLoading(false);
    }
  }

  async function runSingle(action: ActionConfig) {
    if (
      !window.confirm(
        `Run “${action.label}” on ${title}?\n\n` +
          `This posts documents in Business Central and cannot be undone.`,
      )
    )
      return;
    setActionBusy(action.name);
    setActionOutcome(null);
    try {
      const res = await api.runAction(entity, id, action.name);
      setActionOutcome(res.outcome);
      if (res.outcome.ok) onActed();
    } catch (e) {
      setActionOutcome({ id, ok: false, error: (e as Error).message });
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <h3>{title}</h3>
          <button className="icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {actions.length > 0 && (
          <>
            <h4>Actions — single entry, single mutation</h4>
            <div className="chips">
              {actions.map((a) => (
                <button
                  key={a.name}
                  className="danger"
                  disabled={actionBusy !== null}
                  onClick={() => runSingle(a)}
                >
                  {actionBusy === a.name ? "Running…" : a.label}
                </button>
              ))}
            </div>
            {actionOutcome && (
              <div className={`msg ${actionOutcome.ok ? "ok" : "err"}`}>
                {actionOutcome.ok ? "Action completed." : `Failed: ${actionOutcome.error}`}
              </div>
            )}
          </>
        )}

        <h4>Fields (direct dataset)</h4>
        <dl className="kv">
          {Object.entries(item).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{fmt(v)}</dd>
            </div>
          ))}
        </dl>

        <h4>Expand properties — drill down</h4>
        <div className="chips">
          {navProps.map((n) => (
            <button
              key={n}
              className={active === n ? "chip active" : "chip"}
              onClick={() => drill(n)}
            >
              {n}
            </button>
          ))}
        </div>

        {active && (
          <div className="drill-result">
            <h4>
              {active} {result ? `(${result.kind})` : ""}
            </h4>
            {navLoading && <p className="hint">Loading…</p>}
            {navError && <div className="msg err">{navError}</div>}
            {result && result.items.length === 0 && <p className="hint">No related records.</p>}
            {result && result.items.length > 0 && <NavView result={result} />}
          </div>
        )}
      </aside>
    </>
  );
}

function NavView({ result }: { result: NavigationResult }) {
  if (result.kind === "record") {
    const rec = result.items[0];
    return (
      <dl className="kv">
        {Object.entries(rec).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{fmt(v)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  const cols = columnsOf(result.items);
  return (
    <div className="table-wrap">
      <table className="dense">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.items.map((r, i) => (
            <tr key={fmt(r.id) || i}>
              {cols.map((c) => (
                <td key={c} title={fmt(r[c])}>
                  {fmt(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
