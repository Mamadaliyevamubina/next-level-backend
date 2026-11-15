import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import catalogRoutes from './routes/catalog.js';
import accountRoutes from './routes/account.js';
import teacherRoutes from './routes/teacher.js';
import teacherAssignmentRoutes from './routes/teacherAssignments.js';
import assignmentRoutes from './routes/assignments.js';
import adminRoutes from './routes/admin.js';
import practiceRoutes from './routes/practice.js';
import { pool } from './db.js';

// Only these browser origins may call the API (comma-separated in .env). Defaults to the Vite dev server.
const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);

// Turns database connection and setup errors into a message that says what to do.
function databaseProblem(err) {
  const codes = [err.code, ...(err.errors || []).map((e) => e.code)];
  if (codes.includes('ECONNREFUSED') || codes.includes('ENOTFOUND') || codes.includes('ETIMEDOUT')) {
    return 'The database is not running. Start PostgreSQL, then try again.';
  }
  if (err.code === '3D000') return 'The database does not exist yet. Run "npm run db:setup" in next-level-backend.';
  if (err.code === '28P01' || err.code === '28000') return 'The database rejected the password. Check DATABASE_URL in next-level-backend/.env.';
  if (err.code === '42P01' || err.code === '42703') return 'The database is out of date. Run "npm run db:setup" in next-level-backend.';
  if (err.code === '57P01' || err.code === '57P03') return 'The database is restarting. Try again in a moment.';
  return null;
}

const app = express();
app.use(cors({ origin: corsOrigins }));
app.use(express.json({ limit: '200kb' }));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1 FROM users LIMIT 1');
    res.json({ ok: true, database: 'connected' });
  } catch (err) {
    res.status(503).json({ ok: false, database: databaseProblem(err) || err.message || err.code });
  }
});

// Public: course list for the home page (no login needed).
app.use('/api/catalog', catalogRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/account', accountRoutes);
app.use('/api/teacher/assignments', teacherAssignmentRoutes);
app.use('/api/teacher', teacherRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/admin', adminRoutes);
// Practice routes need an approved account. Only their own paths reach them, so a mistyped
// address gets "Not found." below instead of "Please log in.".
const PRACTICE_PATH = /^\/(papers|questions|bookmarks|stats|progress)(\/|$)/;
app.use('/api', (req, res, next) => (PRACTICE_PATH.test(req.path) ? practiceRoutes(req, res, next) : next()));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request was not valid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much text to send at once.' });
  const dbProblem = databaseProblem(err);
  if (dbProblem) {
    console.error(`Database problem: ${dbProblem} (${err.code || err.message})`);
    return res.status(503).json({ error: dbProblem, code: 'database' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => console.log(`API running on http://localhost:${port}`));
