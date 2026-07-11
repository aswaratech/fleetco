// D5 offline outbox — the NATIVE shell (ADR-0035 c2). A single SQLCipher-
// encrypted SQLite database holding captured fixes until the SyncManager
// delivers them. Capture enqueues here (both the foreground-service task and
// the watchPositionAsync fallback); the SyncManager peeks oldest-first, POSTs,
// and deletes on 202 — at-least-once by construction (a crash between the 202
// and the delete re-sends a harmless duplicate; ADR-0035 c4 declined dedup).
//
// Encryption: the app.json plugin option `useSQLCipher: true` compiles the
// SQLCipher build of expo-sqlite; this module supplies the key per connection
// via `PRAGMA key = "x'<hex>'"` — the RAW-key form (32 random bytes, hex), not
// a passphrase, so there is no PBKDF derivation cost on open and no encoding
// ambiguity. The key is generated once (expo-crypto) and lives in
// expo-secure-store (Android Keystore-backed), the same store the auth session
// credential already uses. GPS traces are Tier 2 data (ADR-0013); at-rest
// encryption on a device that leaves the yard is the point of c2.
//
// Key-loss honesty: if the stored key no longer opens the file (secure-store
// wiped but the file left behind, or vice versa), the outbox RESETS — delete
// the file, recreate with the current key. The outbox is a buffer, not the
// source of truth; losing it costs a trail gap (c1's gap-tolerance), never
// corrupts server data. The reset warns count-unknown — never a coordinate
// (ADR-0027 c5: no coordinates in logs, mobile mirror).
//
// Tests never import this file (native modules); the pure policy it applies
// lives in src/outbox.ts.

import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import * as SQLite from "expo-sqlite";

import type { WirePing } from "./gps";
import { agePruneCutoffIso, overCapDeleteCount, type OutboxRow } from "./outbox";

const DB_NAME = "fleetco-outbox.db";
const KEY_STORE_KEY = "fleetco.outbox.dbkey";

// 32 random bytes as 64 hex chars — SQLCipher's raw-key size.
function generateHexKey(): string {
  return Array.from(Crypto.getRandomBytes(32), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function getOrCreateKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEY_STORE_KEY);
  if (existing) {
    return existing;
  }
  const key = generateHexKey();
  await SecureStore.setItemAsync(KEY_STORE_KEY, key);
  return key;
}

// Open + key + probe. `PRAGMA key` MUST be the first statement on the
// connection — any earlier read of an encrypted file fails. The probe read
// against sqlite_master is what actually surfaces a wrong key ("file is not
// a database"); PRAGMA key itself succeeds regardless.
async function openKeyed(key: string): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync(`PRAGMA key = "x'${key}'";`);
  await db.getFirstAsync("SELECT count(*) AS n FROM sqlite_master;");
  return db;
}

async function initSchema(db: SQLite.SQLiteDatabase): Promise<void> {
  // WAL keeps capture inserts and drain reads from blocking each other;
  // synchronous=FULL fsyncs every commit so a buffered fix survives even a
  // power loss (a dead battery mid-trip is this outbox's core scenario, not
  // just an app kill). At ~4 small inserts/min the extra fsync cost is noise.
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS outbox_pings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      altitude REAL,
      speed REAL,
      heading REAL,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_pings_timestamp ON outbox_pings (timestamp);
  `);
}

// Promise singleton: the capture callback and the SyncManager share one JS
// runtime (expo-task-manager runs the task in the app's context), so a single
// connection serves both without an open() race.
let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function openOutbox(): Promise<SQLite.SQLiteDatabase> {
  const key = await getOrCreateKey();
  let db: SQLite.SQLiteDatabase;
  try {
    db = await openKeyed(key);
  } catch {
    // The stored key does not open the file — reset (see the header note).
    console.warn("outbox: stored key no longer opens the database; resetting (buffered fixes lost)");
    await SQLite.deleteDatabaseAsync(DB_NAME);
    db = await openKeyed(key);
  }
  await initSchema(db);
  return db;
}

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = openOutbox().catch((error: unknown) => {
      // A failed open must not poison every later call — clear the memo so
      // the next enqueue/drain retries from scratch.
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

// Buffer captured fixes durably, then enforce the outbox bounds (age-out +
// row cap — src/outbox.ts policy) in the same call so every write leaves the
// invariants holding without a separate maintenance timer. Throws on storage
// failure: the capture glue decides what a lost fix means (count-only warn),
// not this layer.
export async function enqueuePings(pings: readonly WirePing[]): Promise<void> {
  if (pings.length === 0) {
    return;
  }
  const db = await getDb();
  // Deliberately NO explicit transaction: pings are independent rows, a
  // partial batch is fine under the at-least-once posture, and each runAsync
  // autocommits. The D5 E2E caught the alternative failing live: a
  // withTransactionAsync left OPEN when the backgrounded JS thread paused
  // mid-callback (bundled build, API 35) wedged every later statement on the
  // shared connection — enqueues, depth checks and the drain all queued
  // behind it forever. Autocommit statements cannot be left half-open.
  for (const ping of pings) {
    await db.runAsync(
      `INSERT INTO outbox_pings
         (vehicle_id, trip_id, latitude, longitude, altitude, speed, heading, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        ping.vehicleId,
        ping.tripId,
        ping.latitude,
        ping.longitude,
        ping.altitude,
        ping.speed,
        ping.heading,
        ping.timestamp,
      ],
    );
  }

  const aged = await db.runAsync(
    "DELETE FROM outbox_pings WHERE timestamp < ?;",
    [agePruneCutoffIso(Date.now())],
  );
  if (aged.changes > 0) {
    console.warn(`outbox: aged out ${aged.changes} undelivered fix(es) older than the cap`);
  }
  const excess = overCapDeleteCount(await outboxDepth());
  if (excess > 0) {
    await db.runAsync(
      "DELETE FROM outbox_pings WHERE id IN (SELECT id FROM outbox_pings ORDER BY id ASC LIMIT ?);",
      [excess],
    );
    console.warn(`outbox: dropped ${excess} oldest fix(es) over the row cap`);
  }
}

// Oldest-first drain window. Insert order (id ASC) is capture order per
// producer path, and oldest-first delivery keeps the server trail filling in
// chronologically on reconnect.
export async function peekOldestPings(limit: number): Promise<OutboxRow[]> {
  const db = await getDb();
  return db.getAllAsync<OutboxRow>(
    `SELECT id, vehicle_id AS vehicleId, trip_id AS tripId, latitude, longitude,
            altitude, speed, heading, timestamp
     FROM outbox_pings ORDER BY id ASC LIMIT ?;`,
    [limit],
  );
}

// Delete delivered (or server-rejected — the SyncManager's 4xx drop) rows.
export async function deletePings(ids: readonly number[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const db = await getDb();
  // SQLite's default bind-parameter ceiling is 999; chunk defensively even
  // though drain batches sit well under it.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    await db.runAsync(
      `DELETE FROM outbox_pings WHERE id IN (${chunk.map(() => "?").join(",")});`,
      [...chunk],
    );
  }
}

// Queue depth — the SyncManager's flush-decision input and the UI's honest
// "N fixes waiting to sync" count.
export async function outboxDepth(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    "SELECT count(*) AS n FROM outbox_pings;",
  );
  return row?.n ?? 0;
}
