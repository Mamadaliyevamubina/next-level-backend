import pg from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.');
}

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const query = (text, params) => pool.query(text, params);
