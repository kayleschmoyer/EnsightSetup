/**
 * Shared MySQL connection pool for Vercel serverless functions.
 * Module-scope singleton so warm invocations reuse the pool instead of
 * opening a new connection per request. Kept small on purpose: Vercel
 * functions are short-lived and RDS has a finite connection limit — a large
 * pool per function instance risks exhausting it under load (see RDS Proxy
 * as the upgrade path if that happens).
 */
/* global process */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mysql from 'mysql2/promise';

const RDS_CA_BUNDLE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'certs', 'rds-ca-bundle.pem'),
);

let pool;

export function getPool() {
  if (!pool) {
    const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
    if (!DB_HOST || !DB_USER || !DB_PASSWORD || !DB_NAME) {
      throw new Error(
        'Database is not configured: missing DB_HOST/DB_USER/DB_PASSWORD/DB_NAME env vars.',
      );
    }
    pool = mysql.createPool({
      host: DB_HOST,
      port: DB_PORT ? Number(DB_PORT) : 3306,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      ssl: { ca: RDS_CA_BUNDLE, rejectUnauthorized: true },
      connectionLimit: 2,
      idleTimeout: 10_000,
      waitForConnections: true,
      maxIdle: 1,
    });
  }
  return pool;
}
