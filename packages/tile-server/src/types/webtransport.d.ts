/**
 * Supplemental WebTransport / QUIC server-side type declarations for Deno 2.7+.
 *
 * Deno 2.7 ships lib.deno.web.d.ts (WebTransportDatagramDuplexStream,
 * WebTransportBidirectionalStream) and lib.deno.net.d.ts (QuicEndpoint).
 * Only declare what's still missing from those built-ins.
 */

declare interface WebTransportSession {
  readonly ready: Promise<void>;
  readonly closed: Promise<WebTransportCloseInfo>;
  readonly datagrams: WebTransportDatagramDuplexStream;
  readonly incomingBidirectionalStreams: ReadableStream;
  readonly incomingUnidirectionalStreams: ReadableStream;
  createUnidirectionalStream(): Promise<WritableStream>;
  createBidirectionalStream(): Promise<WebTransportBidirectionalStream>;
  close(closeInfo?: WebTransportCloseInfo): void;
}

declare interface WebTransportCloseInfo {
  closeCode?: number;
  reason?: string;
}

// ── Deno QUIC server API (--unstable-net) — not yet in lib.deno.net.d.ts ─────

declare namespace Deno {
  interface QuicListenOptions {
    cert: string;
    key: string;
    alpnProtocols: string[];
  }

  interface QuicIncoming {
    accept(): Promise<QuicConn>;
    refuse(): void;
    ignore(): void;
  }

  interface QuicConn {
    readonly remoteAddr: Deno.NetAddr;
    readonly localAddr: Deno.NetAddr;
    close(info?: WebTransportCloseInfo): void;
  }

  function upgradeWebTransport(conn: QuicConn): Promise<WebTransportSession>;
}
