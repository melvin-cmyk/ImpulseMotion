import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET() {
  const db = getDb()
  const tasks = db.prepare(`
    SELECT t.*, p.name as project_name, p.color as project_color
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    ORDER BY
      CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      t.due_date ASC NULLS LAST
  `).all()
  return NextResponse.json(tasks)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const db = getDb()
  const result = db.prepare(`
    INSERT INTO tasks (title, priority, duration_minutes, due_date, status, project_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    body.title,
    body.priority || 'medium',
    body.duration_minutes || 30,
    body.due_date || null,
    body.status || 'todo',
    body.project_id || null
  )
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(result.lastInsertRowid)
  return NextResponse.json(task, { status: 201 })
}
