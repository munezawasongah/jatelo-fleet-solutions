import { useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { API_BASE, getToken, onAuthChange, refresh } from './api';

let socket: Socket | null = null;

function connect(): Socket {
  if (socket) return socket;
  socket = io(API_BASE || window.location.origin, {
    transports: ['websocket', 'polling'],
    auth: (cb) => cb({ token: getToken() }),
    reconnectionDelayMax: 10_000,
  });
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') void refresh();
  });
  return socket;
}

onAuthChange((signedIn) => {
  if (!signedIn && socket) {
    socket.disconnect();
    socket = null;
  }
});

/** Subscribes to a realtime event while the component is mounted. The handler may change between renders. */
export function useRealtime<T = Record<string, unknown>>(event: string, handler: (payload: T) => void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled || !getToken()) return;
    const s = connect();
    const fn = (p: T): void => ref.current(p);
    s.on(event, fn);
    return () => {
      s.off(event, fn);
    };
  }, [event, enabled]);
}
