import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json()
  const db = getDb()

  const fields = Object.keys(body).map(k => `${k} = ?`).join(', ')
  const values = [...Object.values(body), parseInt(id)]

  db.prepare(`UPDATE tasks SET ${fields} WHERE id = ?`).run(...values)
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parseInt(id))
  return NextResponse.json(task)
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = getDb()
  db.prepare('DELETE FROM tasks WHERE id = ?').run(parseInt(id))
  return NextResponse.json({ success: true })
}
