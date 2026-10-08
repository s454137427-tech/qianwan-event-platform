const fs = require('node:fs');
const path = require('node:path');

const schema = `
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, identity_key TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'participant', password_hash TEXT, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_states (state_hash TEXT PRIMARY KEY, expires_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS wechat_profiles (user_id TEXT PRIMARY KEY REFERENCES users(id), avatar_url TEXT NOT NULL DEFAULT '', updated_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS wechat_oauth_states (state_hash TEXT PRIMARY KEY, scan_hash TEXT, destination TEXT NOT NULL, expires_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS qr_logins (id TEXT PRIMARY KEY, scan_hash TEXT UNIQUE NOT NULL, browser_hash TEXT NOT NULL, display_code TEXT NOT NULL, status TEXT NOT NULL, user_id TEXT REFERENCES users(id), expires_at BIGINT NOT NULL, destination TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_qr_browser ON qr_logins(browser_hash,status);
CREATE INDEX IF NOT EXISTS idx_qr_expiry ON qr_logins(expires_at);
CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), competition TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', seat_count INTEGER NOT NULL DEFAULT 1, checkin_code TEXT UNIQUE, checked_at BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, UNIQUE(user_id,competition));
CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL, size BIGINT NOT NULL, fingerprint TEXT NOT NULL, object_key TEXT NOT NULL, status TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), competition TEXT NOT NULL, title TEXT NOT NULL, author TEXT NOT NULL, description TEXT NOT NULL, video_id TEXT REFERENCES uploads(id), status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', votes INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, submission_key TEXT NOT NULL, UNIQUE(user_id,submission_key));
CREATE TABLE IF NOT EXISTS votes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), work_id TEXT NOT NULL REFERENCES works(id), competition TEXT NOT NULL, created_at BIGINT NOT NULL, UNIQUE(user_id,work_id));
CREATE TABLE IF NOT EXISTS scores (work_id TEXT NOT NULL REFERENCES works(id), judge_id TEXT NOT NULL REFERENCES users(id), score REAL NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY(work_id,judge_id));
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, target_id TEXT NOT NULL, detail TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_work_wall ON works(competition,status,created_at);
CREATE INDEX IF NOT EXISTS idx_work_owner ON works(user_id,created_at);
CREATE INDEX IF NOT EXISTS idx_vote_quota ON votes(user_id,competition);
CREATE INDEX IF NOT EXISTS idx_upload_owner ON uploads(user_id,status);
CREATE INDEX IF NOT EXISTS idx_session_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_upload_resume ON uploads(user_id,fingerprint,kind,size,created_at);
CREATE INDEX IF NOT EXISTS idx_application_review ON applications(competition,status,created_at);
`;

async function openDatabase(config) {
  if (config.databaseUrl) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolSize || 12,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 15000,
      query_timeout: 20000,
      ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined
    });
    pool.on('error', (e) => console.error('数据库连接池错误:', e.code || 'unknown'));
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Serialize first deployment across instances on the same database.
        await client.query('SELECT pg_advisory_xact_lock(712026, 1008)');
        await client.query(
          'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)'
        );
        const applied = await client.query(
          'SELECT version FROM schema_migrations WHERE version=$1',
          [1]
        );
        if (!applied.rowCount) {
          await client.query(schema);
          await client.query('INSERT INTO schema_migrations(version,applied_at) VALUES($1,$2)', [
            1,
            Date.now()
          ]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      await pool.end();
      throw error;
    }
    const api = {
      dialect: 'postgres',
      query: (sql, params = []) => pool.query(sql, params),
      close: () => pool.end()
    };
    api.transaction = async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (s, p = []) => client.query(s, p), dialect: 'postgres' });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    };
    return api;
  }
  fs.mkdirSync(config.dataDir, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(path.join(config.dataDir, 'platform.sqlite'), {
    timeout: 5000
  });
  database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  try {
    database.exec('BEGIN IMMEDIATE');
    database.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)'
    );
    if (!database.prepare('SELECT version FROM schema_migrations WHERE version=?').get(1)) {
      database.exec(schema);
      database
        .prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)')
        .run(1, Date.now());
    }
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } finally {
      database.close();
    }
    throw error;
  }
  // All queries join the same queue so asynchronous transaction callbacks cannot interleave.
  let queue = Promise.resolve();
  function enqueue(fn) {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  }
  function query(sql, params = []) {
    const args = [];
    const statement = database.prepare(
      sql.replace(/\$(\d+)/g, (_, n) => {
        args.push(params[Number(n) - 1]);
        return '?';
      })
    );
    if (/^\s*(SELECT|WITH)/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      const rows = statement.all(...args);
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...args);
    return { rows: [], rowCount: Number(result.changes) };
  }
  return {
    dialect: 'sqlite',
    query: (s, p) => enqueue(() => query(s, p)),
    transaction: (fn) =>
      enqueue(async () => {
        database.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn({ query: async (s, p) => query(s, p), dialect: 'sqlite' });
          database.exec('COMMIT');
          return result;
        } catch (e) {
          database.exec('ROLLBACK');
          throw e;
        }
      }),
    close: () => enqueue(() => database.close())
  };
}
module.exports = { openDatabase };
