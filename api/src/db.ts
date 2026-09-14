import { Pool, type PoolConfig } from "pg";

/**
 * Aspire injects the Postgres connection string in .NET / ADO.NET format:
 *   Host=localhost;Port=5432;Username=postgres;Password=...;Database=bcdata
 * The `pg` library wants a config object, so we translate the keys.
 */
function parseAspireConnectionString(raw: string): PoolConfig {
  const map = new Map<string, string>();
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key) map.set(key, value);
  }
  const get = (...keys: string[]) => {
    for (const k of keys) {
      const v = map.get(k);
      if (v !== undefined) return v;
    }
    return undefined;
  };

  // Allow a plain postgres:// URL too, in case one is provided directly.
  if (raw.startsWith("postgres://") || raw.startsWith("postgresql://")) {
    return { connectionString: raw };
  }

  return {
    host: get("host", "server") ?? "localhost",
    port: Number(get("port") ?? 5432),
    user: get("username", "user id", "userid", "uid"),
    password: get("password", "pwd"),
    database: get("database", "initial catalog"),
  };
}

const connectionString = process.env.ConnectionStrings__bcdata;
if (!connectionString) {
  throw new Error(
    "Missing ConnectionStrings__bcdata. Run the app through the Aspire AppHost (aspire run).",
  );
}

export const pool = new Pool(parseAspireConnectionString(connectionString));

/** Creates the schema if it does not exist. Called once at startup. */
export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bc_setup (
      id             integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      tenant_id      text NOT NULL DEFAULT '',
      client_id      text NOT NULL DEFAULT '',
      client_secret  text NOT NULL DEFAULT '',
      environment    text NOT NULL DEFAULT 'Production',
      company        text NOT NULL DEFAULT '',
      base_url       text NOT NULL DEFAULT '',
      updated_at     timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO bc_setup (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS customers (
      id                     text PRIMARY KEY,
      number                 text,
      display_name           text,
      email                  text,
      phone_number           text,
      address_line1          text,
      city                   text,
      country                text,
      postal_code            text,
      currency_code          text,
      blocked                text,
      balance                numeric,
      last_modified          timestamptz,
      raw                    jsonb NOT NULL,
      synced_at              timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export interface SetupRow {
  tenant_id: string;
  client_id: string;
  client_secret: string;
  environment: string;
  company: string;
  base_url: string;
  updated_at: string;
}

export async function getSetup(): Promise<SetupRow> {
  const { rows } = await pool.query<SetupRow>(
    "SELECT tenant_id, client_id, client_secret, environment, company, base_url, updated_at FROM bc_setup WHERE id = 1",
  );
  return rows[0];
}

export interface SetupInput {
  tenant_id: string;
  client_id: string;
  client_secret?: string; // when omitted/blank, keep the stored secret
  environment: string;
  company: string;
  base_url: string;
}

export async function saveSetup(input: SetupInput): Promise<void> {
  await pool.query(
    `UPDATE bc_setup SET
       tenant_id     = $1,
       client_id     = $2,
       client_secret = CASE WHEN $3::text IS NULL OR $3 = '' THEN client_secret ELSE $3 END,
       environment   = $4,
       company       = $5,
       base_url      = $6,
       updated_at    = now()
     WHERE id = 1`,
    [
      input.tenant_id,
      input.client_id,
      input.client_secret ?? "",
      input.environment,
      input.company,
      input.base_url,
    ],
  );
}
