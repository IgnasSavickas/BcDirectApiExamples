import { useCallback, useEffect, useState } from "react";
import { api, type EntityField, type Rec } from "../api.js";
import { ColumnsMenu } from "./LiveEntity.js";
import { coerce, FieldInput, fmt, READONLY } from "./fieldEditing.js";
import { ITEM_LOOKUP, LOCATION_LOOKUP, LookupModal, type LookupConfig } from "./LookupModal.js";

const ENTITY = "planningOrders";

// Cells with a "…" drill-down: the picked record's keyField becomes the value.
const CELL_LOOKUPS: Record<string, LookupConfig> = {
  itemNumber: ITEM_LOOKUP,
  locationCode: LOCATION_LOOKUP,
};

const BATCH_LOOKUP: LookupConfig = {
  title: "Planning batches",
  entity: "planningBatches",
  select: ["worksheetTemplateName", "name", "description"],
  orderby: ["worksheetTemplateName", "name"],
  keyField: "name",
  columns: ["worksheetTemplateName", "description"],
};

// Never edited or sent: lineNumber is assigned by BC on insert, description is
// filled in by BC from the item, and type is read-only on the worksheet.
const LOCKED = new Set([...READONLY, "lineNumber", "type", "description"]);

// Columns hidden until the user turns them on in the Columns menu.
const HIDDEN_BY_DEFAULT = new Set([
  "id",
  "worksheetTemplateName",
  "journalBatchName",
  "lineNumber",
  "type",
]);

type RowMsg = { ok: boolean; text: string };

/** The selected planning batch (planningBatches) the worksheet is filtered to. */
type Batch = { worksheetTemplateName: string; name: string; description: string };

const odataStr = (v: string) => `'${v.replace(/'/g, "''")}'`;

function batchFilter(batch: Batch | null): string | undefined {
  if (!batch) return undefined;
  return (
    `worksheetTemplateName eq ${odataStr(batch.worksheetTemplateName)}` +
    ` and journalBatchName eq ${odataStr(batch.name)}`
  );
}

/**
 * Planning worksheet — an inline-editable grid over the Marinar `planningOrders`
 * API. The list is served by the generic live route (native paging + $select
 * from the Columns menu); each line is created / modified with its own CONFIRM
 * button and removed with DELETE.
 */
export function PlanningWorksheet() {
  const [fields, setFields] = useState<EntityField[]>([]);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const [showCols, setShowCols] = useState(false);
  // Batch Name filter; null = all lines (no filter).
  const [batch, setBatch] = useState<Batch | null>(null);
  const [showBatches, setShowBatches] = useState(false);
  // Open cell drill-down (row key + field), if any.
  const [cellLookup, setCellLookup] = useState<{ key: string; field: string } | null>(null);

  const [rows, setRows] = useState<Rec[]>([]);
  const [nextLink, setNextLink] = useState<string | undefined>();
  const [stack, setStack] = useState<(string | undefined)[]>([undefined]);
  const [idx, setIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Unsaved new lines (keys "new-1", "new-2", …), shown above the loaded rows.
  const [drafts, setDrafts] = useState<string[]>([]);
  const [draftSeq, setDraftSeq] = useState(1);
  // edits keyed by row key (record id or draft key) -> field -> new string value
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState<Record<string, "confirm" | "delete">>({});
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [rowMsg, setRowMsg] = useState<Record<string, RowMsg>>({});

  const loadPage = useCallback(
    async (token: string | undefined, cols: Set<string>, b: Batch | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await api.getLive(ENTITY, {
          next: token,
          select: cols.size ? [...cols] : undefined,
          filter: batchFilter(b),
        });
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
    [],
  );

  /** Back to page 1 (columns and batch alter $select/$filter, which the nextLink carries). */
  const reload = useCallback(
    (cols: Set<string>, b: Batch | null) => {
      setStack([undefined]);
      setIdx(0);
      setRowMsg({});
      loadPage(undefined, cols, b);
    },
    [loadPage],
  );

  useEffect(() => {
    (async () => {
      try {
        const f = await api.getLiveFields(ENTITY);
        setFields(f.fields);
        const vis = new Set(f.fields.map((x) => x.name).filter((n) => !HIDDEN_BY_DEFAULT.has(n)));
        setVisible(vis);
        reload(vis, null);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [reload]);

  const next = () => {
    if (!nextLink) return;
    const newStack = stack.slice(0, idx + 1);
    newStack.push(nextLink);
    setStack(newStack);
    setIdx(idx + 1);
    loadPage(nextLink, visible, batch);
  };
  const prev = () => {
    if (idx === 0) return;
    setIdx(idx - 1);
    loadPage(stack[idx - 1], visible, batch);
  };

  const toggleCol = (name: string) => {
    const nv = new Set(visible);
    if (nv.has(name)) nv.delete(name);
    else nv.add(name);
    if (nv.size === 0) return; // keep at least one column
    setVisible(nv);
    reload(nv, batch);
  };
  const setAllCols = (on: boolean) => {
    const nv = on ? new Set(fields.map((f) => f.name)) : new Set([fields[0]?.name].filter(Boolean));
    setVisible(nv);
    reload(nv, batch);
  };

  const applyBatch = (b: Batch | null) => {
    setBatch(b);
    setShowBatches(false);
    reload(visible, b);
  };

  // --- edit state helpers ---------------------------------------------------

  const rowByKey = (key: string) => rows.find((r) => fmt(r.id) === key);
  const orig = (key: string, name: string) => fmt(rowByKey(key)?.[name]);
  const current = (key: string, name: string) =>
    edits[key] && name in edits[key] ? edits[key][name] : orig(key, name);

  const changedFields = (key: string) =>
    Object.keys(edits[key] ?? {}).filter((name) => edits[key][name] !== orig(key, name));
  const isDirty = (key: string) => changedFields(key).length > 0;

  function setCell(key: string, name: string, v: string) {
    setRowMsg(({ [key]: _, ...rest }) => rest);
    setEdits((e) => ({ ...e, [key]: { ...(e[key] ?? {}), [name]: v } }));
  }
  function clearRow(key: string) {
    setEdits(({ [key]: _, ...rest }) => rest);
    setBusy(({ [key]: _, ...rest }) => rest);
  }
  const typeOf = (name: string) => fields.find((f) => f.name === name)?.type ?? "Edm.String";

  function addLine() {
    const key = `new-${draftSeq}`;
    setDraftSeq((n) => n + 1);
    setDrafts((d) => [key, ...d]);
    // A new line belongs to the filtered batch, so it stays visible after CONFIRM.
    if (batch) {
      setEdits((e) => ({
        ...e,
        [key]: { worksheetTemplateName: batch.worksheetTemplateName, journalBatchName: batch.name },
      }));
    }
  }

  // --- CONFIRM: create a draft, or PATCH the changed fields of a line -------

  async function confirm(key: string) {
    const isDraft = drafts.includes(key);
    const body: Record<string, unknown> = {};
    for (const name of isDraft ? Object.keys(edits[key] ?? {}) : changedFields(key)) {
      const v = edits[key][name];
      if (LOCKED.has(name) || (isDraft && v.trim() === "")) continue;
      body[name] = coerce(typeOf(name), v);
    }
    setBusy((b) => ({ ...b, [key]: "confirm" }));
    try {
      if (isDraft) {
        const { line } = await api.createPlanningOrder(body);
        setDrafts((d) => d.filter((k) => k !== key));
        setRows((r) => [line, ...r]);
        clearRow(key);
        setRowMsg((m) => ({ ...m, [fmt(line.id)]: { ok: true, text: "Line created." } }));
      } else {
        const { line } = await api.patchPlanningOrder(key, body);
        setRows((r) => r.map((x) => (fmt(x.id) === key ? line : x)));
        clearRow(key);
        setRowMsg((m) => ({ ...m, [key]: { ok: true, text: "Changes saved." } }));
      }
    } catch (e) {
      setBusy(({ [key]: _, ...rest }) => rest);
      setRowMsg((m) => ({ ...m, [key]: { ok: false, text: (e as Error).message } }));
    }
  }

  // --- DELETE: discard a draft, or delete the line in BC (two-step) --------

  async function remove(key: string) {
    if (drafts.includes(key)) {
      setDrafts((d) => d.filter((k) => k !== key));
      clearRow(key);
      setRowMsg(({ [key]: _, ...rest }) => rest);
      return;
    }
    setConfirmDel(null);
    setBusy((b) => ({ ...b, [key]: "delete" }));
    try {
      await api.deletePlanningOrder(key);
      setRows((r) => r.filter((x) => fmt(x.id) !== key));
      clearRow(key);
    } catch (e) {
      setBusy(({ [key]: _, ...rest }) => rest);
      setRowMsg((m) => ({ ...m, [key]: { ok: false, text: (e as Error).message } }));
    }
  }

  const cols = fields.filter((f) => visible.has(f.name));
  const keys = [...drafts, ...rows.map((r) => fmt(r.id))];
  const pending = drafts.length + rows.filter((r) => isDirty(fmt(r.id))).length;

  function renderRow(key: string) {
    const isDraft = drafts.includes(key);
    const dirty = isDraft || isDirty(key);
    const state = busy[key];
    const msg = rowMsg[key];
    return [
      <tr key={key} className={isDraft ? "row-new" : dirty ? "row-dirty" : ""}>
        <td className="row-actions">
          <button
            className="primary"
            onClick={() => confirm(key)}
            disabled={!!state || !dirty}
            title={isDraft ? "Create this line in Business Central" : "Save changes to this line"}
          >
            {state === "confirm" ? "Saving…" : "CONFIRM"}
          </button>
          {confirmDel === key ? (
            <>
              <button className="danger" onClick={() => remove(key)} disabled={!!state}>
                Sure?
              </button>
              <button onClick={() => setConfirmDel(null)} disabled={!!state}>
                Cancel
              </button>
            </>
          ) : (
            <button
              className="danger"
              onClick={() => (isDraft ? remove(key) : setConfirmDel(key))}
              disabled={!!state}
              title={isDraft ? "Discard this new line" : "Delete this line in Business Central"}
            >
              {state === "delete" ? "Deleting…" : "DELETE"}
            </button>
          )}
        </td>
        {cols.map((f) => {
          const cellDirty =
            !isDraft && edits[key] && f.name in edits[key] && edits[key][f.name] !== orig(key, f.name);
          return (
            <td key={f.name} className={cellDirty ? "cell-dirty" : ""}>
              {CELL_LOOKUPS[f.name] && !LOCKED.has(f.name) ? (
                <div className="cell-lookup">
                  <FieldInput
                    field={f}
                    value={current(key, f.name)}
                    disabled={!!state}
                    onChange={(v) => setCell(key, f.name, v)}
                  />
                  <button
                    onClick={() => setCellLookup({ key, field: f.name })}
                    disabled={!!state}
                    title={`Select from ${CELL_LOOKUPS[f.name].title}`}
                  >
                    …
                  </button>
                </div>
              ) : (
                <FieldInput
                  field={f}
                  value={current(key, f.name)}
                  disabled={LOCKED.has(f.name) || !!state}
                  onChange={(v) => setCell(key, f.name, v)}
                />
              )}
            </td>
          );
        })}
      </tr>,
      msg && (
        <tr key={`${key}-msg`} className="row-msg">
          <td colSpan={cols.length + 1}>
            <div className={`msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div>
          </td>
        </tr>
      ),
    ];
  }

  return (
    <section className="card">
      <div className="toolbar">
        <div>
          <h2>
            Planning Worksheet{" "}
            {pending > 0 && <span className="dirty-badge">{pending} unconfirmed</span>}
          </h2>
          <p className="hint" style={{ margin: 0 }}>
            Live from Business Central (planningOrders), 30 per page. Edit cells inline, then
            CONFIRM each line.
          </p>
        </div>
        <div className="toolbar-right">
          <button className="primary" onClick={addLine} disabled={fields.length === 0}>
            + New line
          </button>
          <div className="menu-wrap">
            <button className={showCols ? "active-btn" : ""} onClick={() => setShowCols((v) => !v)}>
              Columns ({visible.size}/{fields.length || "…"})
            </button>
            {showCols && (
              <ColumnsMenu
                fields={fields}
                visible={visible}
                onToggle={toggleCol}
                onAll={() => setAllCols(true)}
                onNone={() => setAllCols(false)}
                onClose={() => setShowCols(false)}
              />
            )}
          </div>
          <button onClick={() => loadPage(stack[idx], visible, batch)} disabled={loading}>
            Refresh
          </button>
          <button onClick={prev} disabled={loading || idx === 0}>
            ‹ Prev
          </button>
          <span className="page-badge">Page {idx + 1}</span>
          <button onClick={next} disabled={loading || !nextLink}>
            Next ›
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <label className="fg-item batch-filter">
          <span>Batch Name</span>
          <div className="batch-field">
            <input
              readOnly
              value={batch ? `${batch.worksheetTemplateName} / ${batch.name}` : ""}
              placeholder="All batches"
              title={batch?.description || undefined}
              onClick={() => setShowBatches(true)}
            />
            <button onClick={() => setShowBatches(true)} title="Select a planning batch">
              …
            </button>
            {batch && (
              <button onClick={() => applyBatch(null)} title="Clear — show all lines">
                ✕
              </button>
            )}
          </div>
        </label>
      </div>

      {showBatches && (
        <LookupModal
          config={BATCH_LOOKUP}
          clearLabel="No filter — show every worksheet line"
          isSelected={(r) =>
            batch?.worksheetTemplateName === fmt(r.worksheetTemplateName) &&
            batch?.name === fmt(r.name)
          }
          onPick={(r) =>
            applyBatch(
              r && {
                worksheetTemplateName: fmt(r.worksheetTemplateName),
                name: fmt(r.name),
                description: fmt(r.description),
              },
            )
          }
          onClose={() => setShowBatches(false)}
        />
      )}

      {cellLookup && (
        <LookupModal
          config={CELL_LOOKUPS[cellLookup.field]}
          isSelected={(r) =>
            fmt(r[CELL_LOOKUPS[cellLookup.field].keyField]) ===
            current(cellLookup.key, cellLookup.field)
          }
          onPick={(r) => {
            if (r) {
              setCell(cellLookup.key, cellLookup.field, fmt(r[CELL_LOOKUPS[cellLookup.field].keyField]));
            }
            setCellLookup(null);
          }}
          onClose={() => setCellLookup(null)}
        />
      )}

      {error && <div className="msg err">{error}</div>}
      {loading && <p className="hint">Loading…</p>}
      {!loading && !error && keys.length === 0 && (
        <p className="hint">No planning lines. Use “+ New line” to add one.</p>
      )}

      {keys.length > 0 && (
        <div className="table-wrap">
          <table className="dense grid-edit">
            <thead>
              <tr>
                <th className="row-actions" />
                {cols.map((f) => (
                  <th key={f.name}>{f.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>{keys.flatMap(renderRow)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
