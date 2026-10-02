import type { EntityField } from "../api.js";

// --- Shared field-editing helpers (Sales Orders card/lines, Planning Worksheet) ---

export const READONLY = new Set(["id", "documentId", "lastModifiedDateTime"]);

const isBool = (t: string) => /Boolean/i.test(t);
const isNum = (t: string) => /Int|Decimal|Double|Single/i.test(t);
const isDate = (t: string) => /\.Date$/i.test(t) || /Edm\.Date$/i.test(t);

export function fmt(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Converts an edited string back to the proper type for the PATCH body. */
export function coerce(type: string, s: string): unknown {
  if (isBool(type)) return s === "true";
  if (isNum(type)) return s.trim() === "" ? null : Number(s);
  return s; // string / guid / date / enum
}

export function FieldInput(props: {
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
  return <input type="text" {...common} />;
}
