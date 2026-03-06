import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET() {
  const db = getDb()
  const projects = db.prepare(`
    SELECT p.*, COUNT(t.id) as task_count
    FROM projects p
    LEFT JOIN tasks t ON t.project_id = p.id
    GROUP BY p.id
    ORDER BY p.name
  `).all()
  return NextResponse.json(projects)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const db = getDb()
  const result = db.prepare('INSERT INTO projects (name, color) VALUES (?, ?)').run(body.name, body.color || '#6366f1')
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid)
  return NextResponse.json(project, { status: 201 })
}
