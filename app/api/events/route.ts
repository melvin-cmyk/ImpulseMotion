import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'

export async function GET(req: NextRequest) {
  const db = getDb()
  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  let query = 'SELECT * FROM events'
  const params: string[] = []

  if (from && to) {
    query += ' WHERE start_time >= ? AND start_time <= ?'
    params.push(from, to)
  }

  const events = db.prepare(query).all(...params)
  return NextResponse.json(events)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const db = getDb()
  const result = db.prepare(`
    INSERT INTO events (title, start_time, end_time, all_day, color)
    VALUES (?, ?, ?, ?, ?)
  `).run(body.title, body.start_time, body.end_time, body.all_day ? 1 : 0, body.color || '#6366f1')
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid)
  return NextResponse.json(event, { status: 201 })
}
