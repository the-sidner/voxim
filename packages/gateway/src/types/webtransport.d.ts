// Shared with @voxim/tile-server — keep in sync.
// Stream properties use unparameterized ReadableStream / WritableStream to
// match lib.dom.d.ts; cast at usage sites for concrete types.
declare interface WebTransportDatagramDuplexStream {
  readonly readable: ReadableStream;
  readonly writable: WritableStream;
}

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

declare interface WebTransportBidirectionalStream {
  readonly readable: ReadableStream;
  readonly writable: WritableStream;
}

declare interface WebTransportCloseInfo {
  closeCode?: number;
  reason?: string;
}
