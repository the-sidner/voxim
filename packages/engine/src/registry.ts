/**
 * Generic handler registry.
 *
 * Used to plug content-defined string dispatch (effect ids, job types, BT
 * node types, recipe step types, etc.) into systems without hardcoded
 * switches. Handlers register at server startup; systems look them up by
 * the id field that lives on the content definition.
 *
 * Missing ids throw — content references must be validated at load time.
 */
export class Registry<H extends { id: string }> {
  private map = new Map<string, H>();

  register(handler: H): void {
    if (this.map.has(handler.id)) {
      throw new Error(`Registry: duplicate handler id "${handler.id}"`);
    }
    this.map.set(handler.id, handler);
  }

  get(id: string): H {
    const h = this.map.get(id);
    if (!h) throw new Error(`Registry: unknown handler id "${id}"`);
    return h;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  ids(): string[] {
    return [...this.map.keys()];
  }
}
