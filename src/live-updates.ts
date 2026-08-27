import { DurableObject } from 'cloudflare:workers';

/** Hibernating, installation-scoped invalidation hub for the signed-in SPA. */
export class LiveUpdates extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('websocket upgrade required', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(): void {
    const message = JSON.stringify({ type: 'invalidate', at: Date.now() });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, 'send failed');
      }
    }
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    // A tiny client heartbeat proves the connection is still usable after a
    // network transition without creating an application-level subscription.
    if (message === '{"type":"ping"}') {
      socket.send('{"type":"pong"}');
    }
  }
}
