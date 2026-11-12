import { redis } from './redis.js';

/** Queues a push notification to all of a user's registered devices (sent by the worker). */
export async function pushToUser(userId: string, title: string, body: string, data: Record<string, string> = {}): Promise<void> {
  await redis.xadd('push', 'MAXLEN', '~', '100000', '*', 'data', JSON.stringify({ user_id: userId, title, body: body.slice(0, 240), data }));
}
