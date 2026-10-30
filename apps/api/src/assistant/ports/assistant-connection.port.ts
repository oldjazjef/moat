import type { AiConnection, AiProviderKind } from '../ai/ai-completion.port';

/** What the page may know about the AI provider: never the key, only whether one is stored. */
export interface AssistantConnectionSummary {
  readonly kind: AiProviderKind;
  /** '' = the provider's default. */
  readonly baseUrl: string;
  /** '' = the provider's default. */
  readonly model: string;
  readonly hasKey: boolean;
}

/**
 * The AI provider the person chose in the main process's own window (T-108): provider, address,
 * model and token are typed there and the token is kept as `safeStorage` ciphertext. The API
 * gets the decrypted connection only for the length of one call and never stores it.
 */
export abstract class AssistantConnectionPort {
  abstract summary(): AssistantConnectionSummary | null;
  abstract open(): Promise<AiConnection | null>;
}

/** The desktop's main process registers its supplier (desktop.ts); until then there is none. */
export class MainProcessConnection extends AssistantConnectionPort {
  private supplier: {
    summary(): AssistantConnectionSummary | null;
    open(): Promise<AiConnection | null>;
  } | null = null;

  register(supplier: {
    summary(): AssistantConnectionSummary | null;
    open(): Promise<AiConnection | null>;
  }): void {
    this.supplier = supplier;
  }

  summary(): AssistantConnectionSummary | null {
    try {
      return this.supplier?.summary() ?? null;
    } catch {
      return null;
    }
  }

  async open(): Promise<AiConnection | null> {
    try {
      return (await this.supplier?.open()) ?? null;
    } catch {
      return null;
    }
  }
}
