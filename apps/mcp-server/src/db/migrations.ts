import { Database } from 'better-sqlite3';
import { initializeSchema, getSchemaVersion, clearDatabase, SCHEMA_VERSION } from './schema';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: initializeSchema
  }
];

export function runMigrations(db: Database): void {
  const currentVersion = getSchemaVersion(db) || 0;
  
  const pendingMigrations = migrations.filter(m => m.version > currentVersion);
  
  for (const migration of pendingMigrations) {
    migration.up(db);
    
    const insertVersion = db.prepare(`
      INSERT INTO schema_version (version, applied_at)
      VALUES (?, ?)
    `);
    insertVersion.run(migration.version, Date.now());
  }
}

export function initializeDatabase(db: Database): void {
  runMigrations(db);
}

export function resetDatabase(db: Database): void {
  clearDatabase(db);
  initializeDatabase(db);
}

export { getSchemaVersion, clearDatabase, SCHEMA_VERSION };
