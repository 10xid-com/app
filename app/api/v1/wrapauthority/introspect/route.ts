import { NextResponse } from 'next/server';
import { authorizeWrapAuthorityAssertion } from '@/lib/auth/authorize';
export const runtime = 'nodejs';
export async function POST(req: Request) {
  try {
    const active = await authorizeWrapAuthorityAssertion(req);
    return NextResponse.json({ active }, { status: active ? 200 : 401, headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ active: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
