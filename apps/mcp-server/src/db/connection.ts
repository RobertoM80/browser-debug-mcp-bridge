import Database from 'better-sqlite3';
import { dirname } from 'path';
import { mkdirSync } from 'fs';
import { getDatabasePath } from '../runtime-paths.js';

export interface DatabaseConnection {
  db: Database.Database;
  isConnected: boolean;
}

let connection: DatabaseConnection | null = null;

export function createConnection(dbPath?: string): DatabaseConnection {
  const path = dbPath || getDatabasePath();
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  
  return {
    db,
    isConnected: true
  };
}

export function getConnection(): DatabaseConnection {
  if (!connection) {
    connection = createConnection();
  }
  return connection;
}

export function closeConnection(): void {
  if (connection) {
    connection.db.close();
    connection = null;
  }
}

export function isConnected(): boolean {
  return connection !== null && connection.isConnected;
}

export function resetConnection(): void {
  closeConnection();
  connection = null;
}
