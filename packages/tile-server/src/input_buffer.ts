import type { MovementDatagram } from "@voxim/protocol";

const DEFAULT_CAPACITY = 128;

/**
 * Per-player movement datagram ring buffer.
 *
 * The input receiver loop pushes datagrams in concurrently as they arrive.
 * The tick loop drains the buffer at the start of each tick.
 *
 * On overflow the oldest input is dropped — a slow tick causes the next tick to
 * catch up by draining a larger buffer. Latest-wins semantics apply within a tick.
 */
export class InputRingBuffer {
  private buf: Array<MovementDatagram | undefined>;
  private head = 0;
  private tail = 0;
  private size = 0;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.buf = new Array(capacity);
  }

  push(input: MovementDatagram): void {
    if (this.size === this.buf.length) {
      // Full — drop oldest to make room
      this.tail = (this.tail + 1) % this.buf.length;
      this.size--;
    }
    this.buf[this.head] = input;
    this.head = (this.head + 1) % this.buf.length;
    this.size++;
  }

  /** Remove and return all buffered inputs in arrival order. */
  drain(): MovementDatagram[] {
    const result: MovementDatagram[] = [];
    while (this.size > 0) {
      result.push(this.buf[this.tail]!);
      this.buf[this.tail] = undefined;
      this.tail = (this.tail + 1) % this.buf.length;
      this.size--;
    }
    return result;
  }

  get length(): number {
    return this.size;
  }
}
