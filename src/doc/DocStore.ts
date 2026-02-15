export interface DocStore {
  readAll(docId: string): Promise<string>;
  readSlice(docId: string, start: number, end: number): Promise<string>;
}

export class InMemoryDocStore implements DocStore {
  private readonly docs = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [docId, text] of Object.entries(seed)) {
      this.docs.set(docId, text);
    }
  }

  static fromSingle(docId: string, text: string): InMemoryDocStore {
    return new InMemoryDocStore({ [docId]: text });
  }

  async readAll(docId: string): Promise<string> {
    const text = this.docs.get(docId);
    if (text === undefined) {
      throw new Error(`doc not found: ${docId}`);
    }
    return text;
  }

  async readSlice(docId: string, start: number, end: number): Promise<string> {
    const text = await this.readAll(docId);
    return text.slice(Math.max(0, start), Math.max(start, end));
  }
}

export interface MCPDocStoreClient {
  readDocument(args: {
    docId: string;
    start?: number;
    end?: number;
  }): Promise<string>;
}

export class MCPDocStore implements DocStore {
  private readonly client: MCPDocStoreClient;

  constructor(client: MCPDocStoreClient) {
    this.client = client;
  }

  async readAll(docId: string): Promise<string> {
    return this.client.readDocument({ docId });
  }

  async readSlice(docId: string, start: number, end: number): Promise<string> {
    return this.client.readDocument({ docId, start, end });
  }
}
