import { query } from './db.js';
import { MARKING_COLUMNS, MarkingError, aiEnabled, markAnswer } from './ai.js';

// Mock exams: assignments of kind 'mock'. The student presses Start, the clock runs for time_limit_min minutes,
// answers are saved to mock_answers (no mark scheme, no marking), and the exam is handed in by the student or
// automatically when time runs out. The AI then suggests a mark for every answer; the teacher confirms or changes
// each mark and releases the results.

// Answers saved up to this long after the clock ends still count (slow connections, the final autosave).
export const GRACE_MS = 30 * 1000;

export const deadlineOf = (row) => (row.started_at && row.time_limit_min
  ? new Date(new Date(row.started_at).getTime() + row.time_limit_min * 60000)
  : null);

// Hands in every mock exam on this assignment whose time has run out, then asks the AI for suggested marks.
// Returns the students that were handed in now.
export async function settleExpired(assignmentId) {
  const { rows } = await query(
    `UPDATE assignment_students ast
        SET submitted_at = ast.started_at + make_interval(mins => a.time_limit_min)
       FROM assignments a
      WHERE a.id = ast.assignment_id AND a.id = $1 AND a.kind = 'mock'
        AND ast.started_at IS NOT NULL AND ast.submitted_at IS NULL
        AND now() > ast.started_at + make_interval(mins => a.time_limit_min) + interval '30 seconds'
      RETURNING ast.student_id`,
    [assignmentId],
  );
  for (const r of rows) queueSuggestions(assignmentId, r.student_id);
  return rows.map((r) => r.student_id);
}

// Every question on the assignment gets a mock_answers row once the exam is handed in, so blank answers
// are marked (0) rather than forgotten.
export async function fillBlankAnswers(assignmentId, studentId) {
  await query(
    `INSERT INTO mock_answers (assignment_id, student_id, question_id)
     SELECT $1, $2, question_id FROM assignment_questions WHERE assignment_id = $1
     ON CONFLICT DO NOTHING`,
    [assignmentId, studentId],
  );
}

const running = new Set();

// Suggested marks from the AI marker for every answer that has none yet. Runs one answer at a time in the
// background; blank answers get 0 without calling the AI. Errors are kept per answer for the teacher to see.
export async function suggestMarks(assignmentId, studentId) {
  const key = `${assignmentId}:${studentId}`;
  if (running.has(key)) return;
  running.add(key);
  try {
    await fillBlankAnswers(assignmentId, studentId);
    const { rows } = await query(
      `SELECT m.answer, ${MARKING_COLUMNS}
         FROM mock_answers m
         JOIN questions q ON q.id = m.question_id
         JOIN papers p ON p.number = q.paper
         LEFT JOIN subjects sub ON sub.id = p.subject_id
         LEFT JOIN exam_papers e ON e.code = q.exam_code
        WHERE m.assignment_id = $1 AND m.student_id = $2 AND m.ai_mark IS NULL`,
      [assignmentId, studentId],
    );
    for (const row of rows) {
      let mark = 0;
      let ticked = [];
      let error = null;
      if (row.answer.trim()) {
        if (!aiEnabled()) {
          error = 'AI marking is not set up on the server.';
        } else {
          try {
            const result = await markAnswer(row, row.answer);
            mark = result.mark;
            ticked = result.ticked;
          } catch (err) {
            error = err instanceof MarkingError ? err.message : 'The AI marker could not mark this answer.';
            if (!(err instanceof MarkingError)) console.error('Mock exam AI marking failed:', err);
          }
        }
      }
      await query(
        `UPDATE mock_answers SET ai_mark = $4, ai_ticked = $5, ai_error = $6
          WHERE assignment_id = $1 AND student_id = $2 AND question_id = $3`,
        [assignmentId, studentId, row.id, error ? null : mark, error ? null : ticked, error],
      );
    }
  } finally {
    running.delete(key);
  }
}

export function queueSuggestions(assignmentId, studentId) {
  suggestMarks(assignmentId, studentId).catch((err) => console.error('Mock exam suggestions failed:', err));
}
