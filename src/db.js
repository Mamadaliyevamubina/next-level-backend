import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
}

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });

// Without this, PostgreSQL stopping or restarting would crash the whole API.
// The broken connection is dropped and the next request opens a new one.
pool.on('error', (err) => console.error('Lost a database connection:', err.message || err.code));

export const query = (text, params) => pool.query(text, params);
