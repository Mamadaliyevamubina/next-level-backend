-- Next Level 9618 practice database.
-- Safe to run more than once: every statement only creates what is missing.

CREATE TABLE IF NOT EXISTS papers (
  number      INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS chapters (
  paper  INTEGER NOT NULL REFERENCES papers(number) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  name   TEXT NOT NULL,
  PRIMARY KEY (paper, number)
);

-- One row per past paper sitting, e.g. s24-21 = 9618/21 May/June 2024.
CREATE TABLE IF NOT EXISTS exam_papers (
  code   TEXT PRIMARY KEY,
  paper  INTEGER NOT NULL REFERENCES papers(number) ON DELETE CASCADE,
  label  TEXT NOT NULL,
  qp_url TEXT NOT NULL DEFAULT '',
  ms_url TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS questions (
  id           TEXT PRIMARY KEY,
  paper        INTEGER NOT NULL REFERENCES papers(number) ON DELETE CASCADE,
  exam_code    TEXT REFERENCES exam_papers(code) ON DELETE SET NULL,
  session      TEXT NOT NULL,
  variant      TEXT NOT NULL,
  label        TEXT NOT NULL,
  marks        INTEGER NOT NULL CHECK (marks >= 0),
  chapter      INTEGER NOT NULL,
  subtopic     TEXT NOT NULL DEFAULT '',
  prompt       TEXT NOT NULL,
  context_note TEXT NOT NULL DEFAULT '',
  answer_type  TEXT NOT NULL DEFAULT 'text',
  criteria     JSONB NOT NULL DEFAULT '[]',
  max_note     TEXT NOT NULL DEFAULT '',
  rejects      JSONB NOT NULL DEFAULT '[]',
  final_answer TEXT NOT NULL DEFAULT '',
  confidence   TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (paper, chapter) REFERENCES chapters(paper, number)
);
CREATE INDEX IF NOT EXISTS questions_paper_chapter_idx ON questions (paper, chapter);

CREATE TABLE IF NOT EXISTS subjects (
  id   SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (lower(email));

-- Accounts: students sign up themselves and wait as "pending" until their teacher
-- (or you, in pgAdmin) sets status to 'approved'. Teachers are created by an admin.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
UPDATE users SET username = lower(split_part(email, '@', 1)) || id WHERE username IS NULL;
ALTER TABLE users ALTER COLUMN username SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_idx ON users (lower(username));

ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'student'
  CHECK (role IN ('student', 'teacher', 'admin'));
-- Accounts that existed before approvals were added stay usable; new sign-ups start as pending.
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved'
  CHECK (status IN ('pending', 'approved', 'rejected'));
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE users ADD COLUMN IF NOT EXISTS class_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS users_teacher_idx ON users (teacher_id);

-- Which subjects each teacher teaches (students pick a teacher for their subject).
CREATE TABLE IF NOT EXISTS teacher_subjects (
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  PRIMARY KEY (teacher_id, subject_id)
);

-- Every time a student marks an answer, a new attempt is stored.
-- "ticked" holds the indexes of the mark-scheme points the student earned.
CREATE TABLE IF NOT EXISTS attempts (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  answer      TEXT NOT NULL DEFAULT '',
  ticked      INTEGER[] NOT NULL DEFAULT '{}',
  awarded     INTEGER NOT NULL CHECK (awarded >= 0),
  marks       INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attempts_user_question_idx ON attempts (user_id, question_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, question_id)
);

-- Courses: each paper belongs to a subject (9618 A Level or 0478 IGCSE) and has a display label.
ALTER TABLE papers ADD COLUMN IF NOT EXISTS subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL;
ALTER TABLE papers ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';
-- Images cropped from the question paper (diagrams, tables, flowcharts) and from the mark scheme.
ALTER TABLE questions ADD COLUMN IF NOT EXISTS figures JSONB NOT NULL DEFAULT '[]';
ALTER TABLE questions ADD COLUMN IF NOT EXISTS answer_figures JSONB NOT NULL DEFAULT '[]';

-- Students with their subject and teacher, for approving accounts in pgAdmin:
-- open the users table and change status to 'approved'.
CREATE OR REPLACE VIEW student_accounts AS
SELECT s.id, s.username, s.name, s.status, s.class_name, sub.name AS subject, t.name AS teacher, s.created_at
FROM users s
LEFT JOIN subjects sub ON sub.id = s.subject_id
LEFT JOIN users t ON t.id = s.teacher_id
WHERE s.role = 'student';

-- Latest attempt per student per question, handy for browsing in pgAdmin.
CREATE OR REPLACE VIEW latest_attempts AS
SELECT DISTINCT ON (user_id, question_id) *
FROM attempts
ORDER BY user_id, question_id, created_at DESC, id DESC;

-- Roles: student, teacher, admin, super_admin.
-- Super admins appoint admins; admins manage teachers and students.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('student', 'teacher', 'admin', 'super_admin'));
-- Who created or last changed the role of an account (an admin or super admin).
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- Assignments: a teacher picks questions (a quiz) and gives them to some of their students.
CREATE TABLE IF NOT EXISTS assignments (
  id           SERIAL PRIMARY KEY,
  teacher_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  due_at       TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assignments_teacher_idx ON assignments (teacher_id);

CREATE TABLE IF NOT EXISTS assignment_questions (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  question_id   TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (assignment_id, question_id)
);

-- Which students got the assignment, and when they handed it in.
CREATE TABLE IF NOT EXISTS assignment_students (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at  TIMESTAMPTZ,
  PRIMARY KEY (assignment_id, student_id)
);
CREATE INDEX IF NOT EXISTS assignment_students_student_idx ON assignment_students (student_id);

-- Answers given while solving an assignment are tagged with it.
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS assignment_id INTEGER REFERENCES assignments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS attempts_assignment_idx ON attempts (assignment_id, user_id, question_id, created_at DESC)
  WHERE assignment_id IS NOT NULL;

-- Latest attempt per student per question inside each assignment.
CREATE OR REPLACE VIEW latest_assignment_attempts AS
SELECT DISTINCT ON (assignment_id, user_id, question_id) *
FROM attempts
WHERE assignment_id IS NOT NULL
ORDER BY assignment_id, user_id, question_id, created_at DESC, id DESC;
