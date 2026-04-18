/**
 * Supplemental WebTransport type declarations for Deno 2.7+.
 *
 * Deno 2.7 ships lib.deno.web.d.ts with WebTransportDatagramDuplexStream and
 * WebTransportBidirectionalStream built in — only declare what's still
 * missing here (the server-side session facade we use after
 * `upgradeWebTransport`).
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
