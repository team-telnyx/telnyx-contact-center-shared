import { NextResponse } from 'next/server';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { receiveGeneratorWebhook } from '@/lib/call-generator/webhook.mjs';

export async function POST(request) {
  const result = await receiveGeneratorWebhook(request,getPostgresPool());
  return NextResponse.json(result.body,{status:result.status});
}
