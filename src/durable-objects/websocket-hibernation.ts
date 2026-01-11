// WebSocket Hibernation Durable Object
// Manages WebSocket connections with Hibernate API for cost-effective persistent connections

export interface Env {
  WEBSOCKET_HIBERNATION: DurableObjectNamespace;
  GRPC_API_URL: string;
}

interface WebSocketSession {
  id: string;
  connectedAt: number;
}

export class WebSocketHibernationDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Map<WebSocket, WebSocketSession> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/websocket') {
      return this.handleWebSocket(request);
    }

    if (url.pathname === '/broadcast') {
      return this.handleBroadcast(request);
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket with Hibernate tags
    this.state.acceptWebSocket(server, ['timecard']);

    const session: WebSocketSession = {
      id: crypto.randomUUID(),
      connectedAt: Date.now(),
    };
    this.sessions.set(server, session);

    // Send initial connection message
    server.send(JSON.stringify({
      type: 'connected',
      sessionId: session.id,
      timestamp: new Date().toISOString()
    }));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleBroadcast(request: Request): Promise<Response> {
    const message = await request.text();
    this.broadcast(message);
    return new Response('OK');
  }

  // Hibernate callback: called when a message is received from a client
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const messageStr = typeof message === 'string' ? message : new TextDecoder().decode(message);

    try {
      const data = JSON.parse(messageStr);

      // Handle ping/pong for keep-alive
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        return;
      }

      // Handle client messages and forward to all connected clients
      if (data.type === 'message') {
        this.broadcast(JSON.stringify({
          type: 'hello',
          data: data.data,
          timestamp: new Date().toISOString()
        }));
      }
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  }

  // Hibernate callback: called when a WebSocket connection is closed
  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    const session = this.sessions.get(ws);
    if (session) {
      console.log(`WebSocket closed: ${session.id}, code: ${code}, reason: ${reason}`);
      this.sessions.delete(ws);
    }
    ws.close(code, reason);
  }

  // Hibernate callback: called when a WebSocket encounters an error
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const session = this.sessions.get(ws);
    if (session) {
      console.error(`WebSocket error for session ${session.id}:`, error);
      this.sessions.delete(ws);
    }
    ws.close(1011, 'WebSocket error');
  }

  // Broadcast message to all connected WebSockets (using Hibernate API)
  private broadcast(message: string): void {
    const websockets = this.state.getWebSockets('timecard');
    for (const ws of websockets) {
      try {
        ws.send(message);
      } catch (e) {
        console.error('Failed to send message:', e);
      }
    }
  }

  // Get count of connected clients
  getConnectionCount(): number {
    return this.state.getWebSockets('timecard').length;
  }
}
