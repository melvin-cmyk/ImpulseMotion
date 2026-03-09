import { NextResponse } from 'next/server'

export async function GET() {
  return new NextResponse('tiktok-developers-site-verification=vWEKPzvuaeiKervgnnetgZzrGjHnHDad', {
    headers: { 'Content-Type': 'text/plain' },
  })
}
