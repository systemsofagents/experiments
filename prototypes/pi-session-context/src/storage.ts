import { DatabaseSync } from "node:sqlite"

export type State<T> = { revision: number; value: T }
export interface Storage<T> {
  read(key: string): State<T> | undefined
  compareAndSet(key: string, revision: number, value: T): boolean
  close(): void
}

export function memory<T>(): Storage<T> {
  const records = new Map<string, State<T>>()
  return {
    read(key) { return structuredClone(records.get(key)) },
    compareAndSet(key, revision, value) {
      if ((records.get(key)?.revision ?? 0) !== revision) return false
      records.set(key, { revision: revision + 1, value: structuredClone(value) })
      return true
    },
    close() {},
  }
}

export function sqlite<T>(path: string): Storage<T> {
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA busy_timeout = 2000;
    CREATE TABLE IF NOT EXISTS context_fixture (
      key TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL
    );`)
  const read = db.prepare("SELECT revision, payload FROM context_fixture WHERE key = ?")
  const insert = db.prepare("INSERT INTO context_fixture VALUES (?, 1, ?) ON CONFLICT DO NOTHING")
  const update = db.prepare("UPDATE context_fixture SET revision = revision + 1, payload = ? WHERE key = ? AND revision = ?")
  return {
    read(key) {
      const row = read.get(key)
      return row && { revision: Number(row.revision), value: JSON.parse(String(row.payload)) as T }
    },
    compareAndSet(key, revision, value) {
      const body = JSON.stringify(value)
      return Number((revision === 0 ? insert.run(key, body) : update.run(body, key, revision)).changes) === 1
    },
    close() { db.close() },
  }
}
