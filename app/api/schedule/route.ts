import { NextResponse } from 'next/server'
import { runAutoScheduler } from '@/lib/scheduler'

export async function POST() {
  const result = runAutoScheduler()
  return NextResponse.json(result)
}
