import { useEffect, useState } from "react";
import { api, type Setup } from "../api.js";

type Msg = { kind: "ok" | "err"; text: string } | null;

const empty = {
  tenant_id: "",
  client_id: "",
  client_secret: "",
  environment: "Production",
  company: "",
  base_url: "",
};

export function SetupPage() {
  const [form, setForm] = useState(empty);
  const [hasSecret, setHasSecret] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  useEffect(() => {
    api
      .getSetup()
      .then((s: Setup) => {
        setForm({ ...empty, ...s, client_secret: "" });
        setHasSecret(s.has_client_secret);
      })
      .catch((e) => setMsg({ kind: "err", text: e.message }));
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  async function run(label: string, fn: () => Promise<Msg>) {
    setBusy(label);
    setMsg(null);
    try {
      setMsg(await fn());
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run("save", async () => {
      await api.saveSetup(form);
      if (form.client_secret) setHasSecret(true);
      setForm({ ...form, client_secret: "" });
      return { kind: "ok", text: "Setup saved." };
    });

  const test = () =>
    run("test", async () => {
      await save();
      const { companies } = await api.test();
      return {
        kind: "ok",
        text: `Connected. Companies: ${companies.map((c) => c.name).join(", ") || "(none)"}`,
      };
    });

  const pull = () =>
    run("pull", async () => {
      await save();
      const { count } = await api.pullCustomers();
      return { kind: "ok", text: `Pulled ${count} customer(s) into the database.` };
    });

  return (
    <section className="card">
      <h2>Business Central connection</h2>
      <p className="hint">
        Credentials for an Entra ID app registration with the Business Central API
        permission (client-credentials flow).
      </p>

      <div className="grid">
        <Field label="Tenant ID" value={form.tenant_id} onChange={set("tenant_id")} placeholder="00000000-0000-0000-0000-000000000000" />
        <Field label="Environment" value={form.environment} onChange={set("environment")} placeholder="Production" />
        <Field label="Client ID" value={form.client_id} onChange={set("client_id")} placeholder="app registration client id" />
        <Field
          label="Client secret"
          value={form.client_secret}
          onChange={set("client_secret")}
          type="password"
          placeholder={hasSecret ? "•••••••• (leave blank to keep)" : "app registration secret"}
        />
        <Field label="Company (optional)" value={form.company} onChange={set("company")} placeholder="defaults to first company" />
        <Field label="Base URL (optional)" value={form.base_url} onChange={set("base_url")} placeholder="https://api.businesscentral.dynamics.com" />
      </div>

      <div className="actions">
        <button onClick={save} disabled={!!busy}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <button onClick={test} disabled={!!busy}>
          {busy === "test" ? "Testing…" : "Test connection"}
        </button>
        <button className="primary" onClick={pull} disabled={!!busy}>
          {busy === "pull" ? "Pulling…" : "Pull customers"}
        </button>
      </div>

      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
    </section>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        onChange={props.onChange}
        placeholder={props.placeholder}
        autoComplete="off"
      />
    </label>
  );
}
