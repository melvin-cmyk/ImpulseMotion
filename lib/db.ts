import Database from 'better-sqlite3'
import path from 'path'

const DB_PATH = path.join(process.cwd(), 'impulse.db')

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  initSchema(db)
  return db
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#6366f1'
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('high','medium','low')),
      duration_minutes INTEGER NOT NULL DEFAULT 30,
      due_date TEXT,
      status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','in-progress','done')),
      project_id INTEGER REFERENCES projects(id),
      scheduled_start TEXT,
      scheduled_end TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      color TEXT DEFAULT '#6366f1'
    );
  `)

  // Seed if empty
  const count = (db.prepare('SELECT COUNT(*) as c FROM projects').get() as { c: number }).c
  if (count === 0) {
    seedData(db)
  }
}

function seedData(db: Database.Database) {
  const insertProject = db.prepare('INSERT INTO projects (name, color) VALUES (?, ?)')
  const p1 = insertProject.run('Product Launch', '#6366f1')
  const p2 = insertProject.run('Marketing', '#f59e0b')
  const p3 = insertProject.run('Personal', '#10b981')

  const insertTask = db.prepare(`
    INSERT INTO tasks (title, priority, duration_minutes, due_date, status, project_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const today = new Date()
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000).toISOString().split('T')[0]

  insertTask.run('Finalize product roadmap', 'high', 90, addDays(today, 2), 'todo', p1.lastInsertRowid)
  insertTask.run('Write launch announcement', 'high', 60, addDays(today, 3), 'todo', p1.lastInsertRowid)
  insertTask.run('Design landing page', 'medium', 120, addDays(today, 5), 'in-progress', p1.lastInsertRowid)
  insertTask.run('Set up Meta Ads campaign', 'high', 45, addDays(today, 1), 'todo', p2.lastInsertRowid)
  insertTask.run('Write ad copy variants', 'medium', 60, addDays(today, 2), 'todo', p2.lastInsertRowid)
  insertTask.run('Analyze last week results', 'medium', 30, addDays(today, 1), 'todo', p2.lastInsertRowid)
  insertTask.run('Review competitor pricing', 'low', 45, addDays(today, 7), 'todo', p1.lastInsertRowid)
  insertTask.run('Gym session', 'low', 60, addDays(today, 1), 'todo', p3.lastInsertRowid)
  insertTask.run('Read "Scientific Advertising"', 'low', 30, addDays(today, 4), 'todo', p3.lastInsertRowid)
  insertTask.run('Weekly review', 'medium', 45, addDays(today, 6), 'todo', p3.lastInsertRowid)

  const insertEvent = db.prepare(`
    INSERT INTO events (title, start_time, end_time, all_day, color) VALUES (?, ?, ?, ?, ?)
  `)

  const todayStr = today.toISOString().split('T')[0]
  const tomorrowStr = addDays(today, 1)
  const dayAfterStr = addDays(today, 2)

  insertEvent.run('Team standup', `${todayStr}T09:00:00`, `${todayStr}T09:30:00`, 0, '#6366f1')
  insertEvent.run('Client call - Meta review', `${todayStr}T14:00:00`, `${todayStr}T15:00:00`, 0, '#f59e0b')
  insertEvent.run('Design sync', `${tomorrowStr}T11:00:00`, `${tomorrowStr}T12:00:00`, 0, '#10b981')
  insertEvent.run('Investor meeting', `${dayAfterStr}T10:00:00`, `${dayAfterStr}T11:30:00`, 0, '#ef4444')
}

export type Task = {
  id: number
  title: string
  priority: 'high' | 'medium' | 'low'
  duration_minutes: number
  due_date: string | null
  status: 'todo' | 'in-progress' | 'done'
  project_id: number | null
  scheduled_start: string | null
  scheduled_end: string | null
  created_at: string
}

export type Project = {
  id: number
  name: string
  color: string
}

export type CalendarEvent = {
  id: number
  title: string
  start_time: string
  end_time: string
  all_day: number
  color: string
}
