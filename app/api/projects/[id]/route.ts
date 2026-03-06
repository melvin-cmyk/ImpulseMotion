import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = getDb()
  // Unlink tasks before deleting project
  db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(parseInt(id))
  db.prepare('DELETE FROM projects WHERE id = ?').run(parseInt(id))
  return NextResponse.json({ success: true })
}
