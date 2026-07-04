import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { ControllerCommand, ControllerSnapshot, JsonValue } from "../shared/protocol";

export type StoredCommand = {
  commandId: string;
  kind: string;
  status: string;
  request: JsonValue;
  response?: JsonValue;
  createdAt: number;
  sentAt?: number;
  completedAt?: number;
};

const DATA_DIR = join(import.meta.dir, "..", "..", "..", "data");
const DB_PATH = join(DATA_DIR, "me-controller.sqlite");

function now() {
  return Date.now();
}

function json(value: unknown) {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class Store {
  private db: Database;

  constructor(path = DB_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec(`
      create table if not exists snapshots (
        id integer primary key autoincrement,
        created_at integer not null,
        payload text not null
      );

      create table if not exists events (
        id integer primary key autoincrement,
        created_at integer not null,
        kind text not null,
        payload text not null
      );

      create table if not exists commands (
        command_id text primary key,
        kind text not null,
        status text not null,
        request text not null,
        response text,
        created_at integer not null,
        sent_at integer,
        completed_at integer
      );
    `);
  }

  saveSnapshot(snapshot: ControllerSnapshot) {
    this.db
      .query("insert into snapshots (created_at, payload) values (?, ?)")
      .run(now(), json(snapshot));
    this.db.query("delete from snapshots where id not in (select id from snapshots order by id desc limit 200)").run();
  }

  latestSnapshot(): ControllerSnapshot | null {
    const row = this.db
      .query("select payload from snapshots order by id desc limit 1")
      .get() as { payload: string } | null;
    return row ? parseJson<ControllerSnapshot>(row.payload, {}) : null;
  }

  saveEvent(kind: string, payload: JsonValue) {
    this.db.query("insert into events (created_at, kind, payload) values (?, ?, ?)").run(now(), kind, json(payload));
    this.db.query("delete from events where id not in (select id from events order by id desc limit 1000)").run();
  }

  createCommand(commandId: string, command: ControllerCommand) {
    this.db
      .query(
        `insert or replace into commands
         (command_id, kind, status, request, created_at, sent_at)
         values (?, ?, ?, ?, ?, ?)`
      )
      .run(commandId, command.kind || command.type || "command", "sent", json(command), now(), now());
  }

  acknowledgeCommand(commandId: string, ok: boolean, response: JsonValue) {
    this.db
      .query("update commands set status = ?, response = ?, completed_at = ? where command_id = ?")
      .run(ok ? "acknowledged" : "failed", json(response), ok ? null : now(), commandId);
  }

  syncAcknowledgedCommands() {
    this.db
      .query("update commands set status = ?, completed_at = ? where status = ?")
      .run("synced", now(), "acknowledged");
  }

  recentCommands(limit = 50): StoredCommand[] {
    const rows = this.db
      .query("select * from commands order by created_at desc limit ?")
      .all(limit) as Array<{
      command_id: string;
      kind: string;
      status: string;
      request: string;
      response: string | null;
      created_at: number;
      sent_at: number | null;
      completed_at: number | null;
    }>;

    return rows.map((row) => ({
      commandId: row.command_id,
      kind: row.kind,
      status: row.status,
      request: parseJson<JsonValue>(row.request, null),
      response: parseJson<JsonValue | undefined>(row.response, undefined),
      createdAt: row.created_at,
      sentAt: row.sent_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
    }));
  }
}
