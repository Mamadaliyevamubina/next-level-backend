# Next Level backend · IGCSE 0478 and 0620, A Level 9618 and 9701

Express + PostgreSQL API for the Dombit International School past-paper practice site (Cambridge IGCSE Computer Science 0478 and Chemistry 0620, and AS & A Level Computer Science 9618 and Chemistry 9701). The React frontend and the static pages live in the [Next-Level](https://github.com/Mamadaliyevamubina/Next-Level) repository.

Students sign up with a login name, choose their subject, teacher and class, and wait until their teacher approves them. Every account, answer, mark and bookmark is stored in a PostgreSQL database that you can open in pgAdmin.

```
src/            Express API (routes in src/routes/)
db/schema.sql   Tables and views; safe to run more than once
scripts/        setup-db.js, create-user.js, export-alevel.js
seed/           Question banks loaded by db:setup
```

## Full app

```
Next-Level/client/   React app (Vite)              → http://localhost:5173
this repo            Express API + PostgreSQL      → http://localhost:4000
```

On this computer both are on the Desktop: `~/Desktop/9618-practice` (the Next-Level frontend) and `~/Desktop/next-level-backend` (this API). Run `npm run dev` here first, then `npm run dev` in `9618-practice/client`; the frontend forwards `/api` to `http://localhost:4000` (see [Connecting the frontend](#connecting-the-frontend)).

## Roles

| Role | Can do |
|---|---|
| `super_admin` | Everything. The only role that can create, promote, edit, block or delete **admins** (and other super admins), and the only role that can permanently delete accounts. The first one is made with `npm run create-user -- --role super_admin …` |
| `admin` | See every account, every student's progress and every teacher's assignments. Create teachers and students, approve/block them, edit them, reset their passwords, move students to another teacher, switch someone between student and teacher. **Cannot** touch admin or super admin accounts, give anyone admin rights, or delete accounts (block them instead) |
| `teacher` | See only the students who chose them: approve sign-ups, view their performance, and create **assignments** (quizzes from the question bank) for individual students or whole classes, then see each student's answers, score and whether they handed it in |
| `student` | Their own profile and progress only. Practise questions from their course, and solve and hand in the assignments their teacher gave them |

Nobody can change their own role or status through the admin API, so a super admin can never lock themselves out.

**Accounts:** students sign up themselves (pending until approved), teachers are created by an admin or super admin (or with the script), admins are appointed by a super admin. Each student has an Account page with profile, class details, appearance (light/dark, accent colour, text size, readable font, compact layout, reduced motion), study preferences (daily goal, main paper, streak) and security (change password, delete account).

**Teachers** see only the students who chose them: approve or block sign-ups, class averages, the topics the class finds hardest, and for each student their score by paper and chapter, weakest topics, 4-week activity and recent answers. An admin sees every student.

**Practice features:** all 12,884 questions by paper and chapter, search and filters (exam sitting, not tried, lost marks, full marks, saved), self-marking against the mark scheme points, history of every try, "practise next" (picks questions you have not tried or lost marks on), saved questions, and a dashboard with your score, weakest topics and daily streak.

## Question data

| Seed file | Paper | Question parts |
|---|---|---|
| `seed/alevel-paper1.json` | 9618 Paper 1 – Theory Fundamentals | 409 |
| `seed/alevel-paper2.json` | 9618 Paper 2 – Fundamental Problem-solving and Programming Skills | 463 |
| `seed/alevel-paper3.json` | 9618 Paper 3 – Advanced Theory | 373 |
| `seed/alevel-paper4.json` | 9618 Paper 4 – Practical (Python) | 242 |
| `seed/igcse-paper1.json` | IGCSE Paper 1 – Computer Systems (paper number 11) | 807 |
| `seed/igcse-paper2.json` | IGCSE Paper 2 – Algorithms, Programming and Logic (paper number 12) | 504 |
| `seed/chemistry-paper1.json` | IGCSE Chemistry Paper 1 – Multiple Choice, Core (paper number 21) | 1,000 |
| `seed/chemistry-paper2.json` | IGCSE Chemistry Paper 2 – Multiple Choice, Extended (paper number 22) | 1,000 |
| `seed/chemistry-paper3.json` | IGCSE Chemistry Paper 3 – Theory, Core (paper number 23) | 1,376 |
| `seed/chemistry-paper4.json` | IGCSE Chemistry Paper 4 – Theory, Extended (paper number 24) | 1,235 |
| `seed/chemistry-paper5.json` | IGCSE Chemistry Paper 5 – Practical Test (paper number 25) | 410 |
| `seed/chemistry-paper6.json` | IGCSE Chemistry Paper 6 – Alternative to Practical (paper number 26) | 542 |
| `seed/chemistry-alevel-paper1.json` | A Level Chemistry 9701 Paper 1 – Multiple Choice (AS) (paper number 41) | 999 |
| `seed/chemistry-alevel-paper2.json` | A Level Chemistry 9701 Paper 2 – AS Level Structured Questions (paper number 42) | 933 |
| `seed/chemistry-alevel-paper3.json` | A Level Chemistry 9701 Paper 3 – Advanced Practical Skills (AS) (paper number 43) | 615 |
| `seed/chemistry-alevel-paper4.json` | A Level Chemistry 9701 Paper 4 – A Level Structured Questions (paper number 44) | 1,425 |
| `seed/chemistry-alevel-paper5.json` | A Level Chemistry 9701 Paper 5 – Planning, Analysis and Evaluation (paper number 45) | 551 |

Every IGCSE and A Level Chemistry question comes from an official Cambridge (CAIE) question paper and its published mark scheme, Feb/March 2023 to May/June 2026. A Level Chemistry topics follow the 9701 syllabus (1–22 AS Level, 23–37 A Level). `db:setup` checks this before loading: it stops if a seed file contains a paper that is not a Cambridge paper of that syllabus.

Every file has the shape `{ items, papers, skipped, chapters }`. The A Level files were exported from the banks embedded in `paper1.html`–`paper4.html` in the Next-Level repo. If those pages change, export them again and rerun `db:setup`:

```bash
node scripts/export-alevel.js ../Next-Level      # folder that holds paper1.html–paper4.html
```

The IGCSE files are copies of `data/igcse-paper1.json`, `data/igcse-paper2.json` and `data/chemistry-paper1…6.json` and `data/chemistry-alevel-paper1…5.json` from the Next-Level repo (built there with `tools/igcse/`); copy them again when they change.

Questions refer to images by path, e.g. `figures/igcse/x.jpg`. The images are not in this repo: the frontend serves them from its `public/figures/` folder.

## Setup

You need [Node.js](https://nodejs.org) 20+ and PostgreSQL (the installer from postgresql.org includes pgAdmin 4).

1. **Start PostgreSQL.** On a Mac with the postgresql.org installer it normally starts with the computer. Open pgAdmin and connect to *PostgreSQL 16* to check it is running.

2. **Configure the server.**
   ```bash
   cp .env.example .env
   ```
   Open `.env` and set:

   | Variable | Meaning |
   |---|---|
   | `DATABASE_URL` | Your PostgreSQL connection, with the `postgres` password you chose when installing |
   | `JWT_SECRET` | Any long random text. It signs login tokens, so keep it secret |
   | `PORT` | Port the API listens on (default `4000`) |
   | `CORS_ORIGINS` | Comma-separated list of browser origins allowed to call the API (default `http://localhost:5173`) |

   If you already used the old `server/` folder in Next-Level, copy its `.env` here and add `CORS_ORIGINS`. Your existing `next_level` database keeps working as it is.

3. **Install and create the database.**
   ```bash
   npm install
   npm run db:setup
   ```
   This creates a `next_level` database if it does not exist, creates any missing tables and loads every question from `seed/`. It is safe to run again; it updates questions without touching student data.

4. **Start the API** (keep this terminal open):
   ```bash
   npm run dev       # restarts when you edit a file
   npm start         # for production
   ```
   Check it at http://localhost:4000/api/health.

5. **Create the teacher accounts** (students can only pick teachers that exist):
   ```bash
   npm run create-user -- --role teacher --username ms.karimova --name "Dilnoza Karimova" --password "choose-a-password" --subject 9618
   npm run create-user -- --role admin --username admin --name "School Admin" --password "choose-a-password"
   npm run create-user -- --role super_admin --username owner --name "Site Owner" --password "choose-a-password"
   ```
   Make at least one `super_admin` this way; after that, admins and teachers can be created in the app through `/api/admin/users`.
   For an IGCSE Computer Science teacher use `--subject 0478`, for IGCSE Chemistry `--subject 0620`, for A Level Chemistry `--subject 9701`; a teacher of several uses e.g. `--subject 9618,0478`. Running it with an existing login name turns that account into a teacher/admin instead. Subjects live in the `subjects` table; `9618`, `0478`, `0620` and `9701` are added by `db:setup`.

**Courses:** a student who chooses *Computer Science IGCSE (0478)* sees only IGCSE Papers 1 and 2; a *Chemistry IGCSE (0620)* student sees Chemistry Papers 1–6; a *Chemistry (9701)* student sees A Level Chemistry Papers 1–5; a *Computer Science (9618)* student sees Papers 1–4. Teachers see the papers of the subjects they teach, and the admin sees everything.

## Connecting the frontend

The React app calls the API at `/api/...` on its own origin.

- **Local development:** nothing to change. `client/vite.config.js` in Next-Level proxies `/api` to `http://localhost:4000` (or to `API_PROXY_TARGET` in `client/.env` if this API runs on another port). Start this API, then in Next-Level run `cd client && npm install && npm run dev` and open http://localhost:5173.
- **Production:** either serve the built frontend and this API behind one domain, with `/api` forwarded to this server (no CORS needed), or host them on different domains, add the frontend's origin to `CORS_ORIGINS`, and set `VITE_API_URL` in the frontend's `client/.env` to this server's full URL before building.

## Approving students

New students start as **pending** and only see a "Waiting for your teacher" page. Approve them in either place:

- **In the app:** the teacher logs in, opens **My students** and presses **Approve** (or **Reject**).
- **In pgAdmin:** open the `users` table (View/Edit Data → All Rows), find the student by `username`, change `status` to `approved` and press **Save Data Changes** (F6). Use `rejected` to block someone. The change takes effect immediately.

The `student_accounts` view lists every student with their subject, teacher and class, which makes finding someone easier.

To make an account a teacher in pgAdmin instead of using the script, set `role` to `teacher` and add a row to `teacher_subjects` with their user id and the subject id.

## Viewing the data in pgAdmin

In pgAdmin open **Servers → PostgreSQL 16 → Databases → next_level → Schemas → public → Tables**. Right-click a table and choose **View/Edit Data → All Rows**.

| Table | What it holds |
|---|---|
| `papers`, `chapters`, `exam_papers` | Paper titles, chapter names and each past paper sitting. IGCSE Computer Science papers are numbers 11 and 12 (subject 0478); IGCSE Chemistry papers are 21–26 (subject 0620); A Level Chemistry papers are 41–45 (subject 9701) |
| `questions` | Every question with its mark scheme (`criteria` is JSON). IGCSE ids start with `ig-`; `figures` / `answer_figures` list the images |
| `users` | Every account: `username` (login name), `role` (student/teacher/admin), `status` (pending/approved/rejected), `class_name`, `subject_id`, `teacher_id`, `settings` (JSON). Passwords are stored hashed, never as plain text |
| `subjects`, `teacher_subjects` | Subjects, and which teacher teaches which subject |
| `student_accounts` (view) | Students with their subject, teacher and class |
| `attempts` | Every answer a student has marked: the answer, ticked points and mark. `assignment_id` is set when the answer was given inside an assignment |
| `assignments`, `assignment_questions`, `assignment_students` | Quizzes teachers set, their questions in order, and which students got them (with `submitted_at`) |
| `latest_assignment_attempts` (view) | The most recent try per student per question inside each assignment |
| `bookmarks` | Questions each student has saved |
| `latest_attempts` (view) | Only the most recent try per student per question |

Example query (Tools → Query Tool):

```sql
SELECT u.name, q.paper, count(*) AS answered, sum(a.awarded) AS earned, sum(a.marks) AS available
FROM latest_attempts a
JOIN users u ON u.id = a.user_id
JOIN questions q ON q.id = a.question_id
GROUP BY u.name, q.paper
ORDER BY u.name, q.paper;
```

## API

All routes except `/api/catalog`, `/api/auth/register`, `/api/auth/login`, `/api/auth/options` and `/api/health` need an `Authorization: Bearer <token>` header. Practice routes also need an approved account.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | Checks the API and the database connection |
| GET | `/api/catalog` | Public: courses with their papers, chapters and live question counts (the frontend's home page) |
| GET | `/api/auth/options` | Subjects and teachers for the sign-up form |
| POST | `/api/auth/register` | Student sign-up `{ name, username, email?, password, subject_id, teacher_id, class_name }` |
| POST | `/api/auth/login` | Log in with login name (or email) and password, returns a token |
| GET | `/api/auth/me` | Current user, with subject, teacher and settings |
| PATCH | `/api/account/profile` | Change name, login name, email, class, subject or teacher (a new teacher means re-approval) |
| PATCH | `/api/account/settings` | Appearance and study settings |
| POST | `/api/account/password` | Change password `{ current, next }` |
| DELETE | `/api/account` | Delete own student account `{ password }` |
| GET | `/api/teacher/students` | Teacher: their students with scores per paper and recent activity |
| GET | `/api/teacher/overview` | Teacher: class summaries and hardest topics |
| GET | `/api/teacher/students/:id` | Teacher: one student in detail |
| POST | `/api/teacher/students/:id/status` | Teacher: approve / reject a student `{ status }` |
| GET | `/api/teacher/assignments` | Teacher: their assignments with counts (admins see all) |
| POST | `/api/teacher/assignments` | Teacher: create `{ title, instructions?, due_at?, question_ids, student_ids?, class_names? }` |
| GET | `/api/teacher/assignments/:id` | Teacher: questions and each student's score and submission |
| PATCH | `/api/teacher/assignments/:id` | Teacher: change `{ title?, instructions?, due_at?, question_ids?, add_student_ids?, add_class_names?, remove_student_ids? }` |
| POST | `/api/teacher/assignments/:id/students/:studentId/reopen` | Teacher: let a student change a handed-in assignment |
| DELETE | `/api/teacher/assignments/:id` | Teacher: delete an assignment |
| GET | `/api/assignments` | Student: my assignments with progress |
| GET | `/api/assignments/:id` | Student: the questions (with mark scheme for self-marking) and my latest answer to each |
| POST | `/api/assignments/:id/questions/:questionId/attempts` | Student: save a marked answer `{ answer, ticked, awarded }` |
| POST | `/api/assignments/:id/submit` | Student: hand it in (answers lock until the teacher reopens it) |
| GET | `/api/admin/overview` | Admin: accounts by role and status, weekly activity, assignment counts |
| GET | `/api/admin/users` | Admin: every account; filters `role`, `status`, `search`. Each row has `can_manage` |
| POST | `/api/admin/users` | Admin: create `{ role, name, username, email?, password, subjects? (teacher), subject_id, teacher_id, class_name (student) }` |
| PATCH | `/api/admin/users/:id` | Admin: edit `{ name?, email?, status?, class_name?, subject_id?, teacher_id?, subjects? }` |
| POST | `/api/admin/users/:id/role` | Admin: change role `{ role }` (admin roles need a super admin) |
| POST | `/api/admin/users/:id/password` | Admin: set a new password `{ password }` |
| DELETE | `/api/admin/users/:id` | Super admin: delete an account |
| GET | `/api/papers` | Papers, chapters, exam sittings and your progress |
| GET | `/api/papers/:paper/questions` | Question list; filters `chapter`, `exam`, `type`, `search`, `status` (`new`/`review`/`done`), `bookmarked=1` |
| GET | `/api/papers/:paper/next` | Suggested next question (optional `chapter`) |
| GET | `/api/questions/:id` | Question, mark scheme, previous/next and your tries |
| POST | `/api/questions/:id/attempts` | Save a marked answer `{ answer, ticked, awarded }` |
| PUT / DELETE | `/api/questions/:id/bookmark` | Save / unsave a question |
| GET | `/api/bookmarks` | Saved questions |
| GET | `/api/stats` | Totals, weakest topics, recent answers, streak |
| DELETE | `/api/progress?paper=N` | Clear your answers for one paper (or all, without `paper`) |
