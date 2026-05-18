/**
 * ETΞRNET — Ghost Mailbox (Capítulo 7)
 *
 * Sistema de mensagens anônimas e efêmeras usando criptografia
 * ChaCha20-Poly1305 com chaves derivadas.
 *
 * Características:
 * - Endereço anônimo derivado do GhostID
 * - Mensagens criptografadas com ChaCha20-Poly1305
 * - Auto-decaimento: mensagens expiram e são deletadas
 * - Anonimato: remetente não pode ser rastreado
 *
 * Referência: "O Livro do ETRNET", Cap. 7
 */

import { sha3_256 } from "@noble/hashes/sha3.js";
import { secureRandomId } from "../utils/secureRandom";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** Mensagem criptografada na mailbox */
export interface MailMessage {
  /** Identificador único da mensagem */
  id: string;
  /** Remetente (pseudônimo ou "anonymous") */
  from: string;
  /** Corpo criptografado (ChaCha20-Poly1305) */
  bodyEncrypted: Uint8Array;
  /** Nonce usado na criptografia */
  nonce: Uint8Array;
  /** Timestamp de recebimento */
  receivedAt: number;
  /** Data de expiração */
  expiresAt: number;
}

/** Caixa de correio fantasma */
export interface GhostMailbox {
  /** Identificador único da mailbox */
  id: string;
  /** ID do GhostID proprietário */
  ghostId: string;
  /** Endereço anônimo para envio */
  anonymousAddress: string;
  /** Mensagens armazenadas */
  messages: MailMessage[];
  /** Data de expiração da mailbox */
  expiryDate: number;
}

// ─── Derivação de Chave ──────────────────────────────────────────────────────

/**
 * Deriva uma chave de criptografia a partir do GhostID.
 *
 * key = SHA3-256(ghostId + "ghost_mailbox_key")
 *
 * @param ghostId - Identificador do proprietário
 * @returns Chave de 32 bytes para ChaCha20-Poly1305
 */
function deriveKey(ghostId: string): Uint8Array {
  const keyMaterial = `ghost_mailbox_key:${ghostId}`;
  return sha3_256(new TextEncoder().encode(keyMaterial));
}

/**
 * Gera um endereço anônimo a partir do GhostID.
 *
 * address = SHA3-256(ghostId + "anonymous_address").substring(0, 16)
 *
 * @param ghostId - Identificador do proprietário
 * @returns Endereço anônimo (16 caracteres hex)
 */
function deriveAnonymousAddress(ghostId: string): string {
  const hash = sha3_256(
    new TextEncoder().encode(`anonymous:${ghostId}:${Date.now()}`)
  );
  return Array.from(hash)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, 16);
}

// ─── Criptografia ────────────────────────────────────────────────────────────

/**
 * Criptografa uma mensagem com ChaCha20-Poly1305.
 *
 * @param plaintext - Texto plano
 * @param key - Chave de 32 bytes
 * @returns Objeto com ciphertext e nonce
 */
function encryptMessage(
  plaintext: string,
  key: Uint8Array
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  // Nonce aleatório de 12 bytes (recomendado para ChaCha20-Poly1305)
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);

  const cipher = chacha20poly1305(key, nonce);
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = cipher.encrypt(plaintextBytes);

  return { ciphertext, nonce };
}

/**
 * Descriptografa uma mensagem com ChaCha20-Poly1305.
 *
 * @param ciphertext - Texto criptografado
 * @param nonce - Nonce usado na criptografia
 * @param key - Chave de 32 bytes
 * @returns Texto descriptografado
 * @throws Error se a descriptografia falhar (chave errada ou dados corrompidos)
 */
function decryptMessage(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  key: Uint8Array
): string {
  const cipher = chacha20poly1305(key, nonce);
  const plaintextBytes = cipher.decrypt(ciphertext);
  return new TextDecoder().decode(plaintextBytes);
}

// ─── Gerenciador Ghost Mailbox (Singleton) ───────────────────────────────────

/**
 * Gerenciador de Ghost Mailbox (singleton).
 *
 * Gerencia caixas de correio anônimas e efêmeras
 * com criptografia ponta-a-ponta.
 */
export class GhostMailboxManager {
  private static instance: GhostMailboxManager;
  private mailboxes: Map<string, GhostMailbox> = new Map();

  public static getInstance(): GhostMailboxManager {
    if (!GhostMailboxManager.instance) {
      GhostMailboxManager.instance = new GhostMailboxManager();
    }
    return GhostMailboxManager.instance;
  }

  private constructor() {}

  /**
   * Cria uma nova caixa de correio fantasma.
   *
   * @param ghostId - ID do GhostID proprietário
   * @param ttlMs - Tempo de vida em milissegundos (padrão: 24 horas)
   * @returns A mailbox criada com endereço anônimo
   */
  createMailbox(
    ghostId: string,
    ttlMs: number = 24 * 60 * 60 * 1000
  ): GhostMailbox {
    const id = `gmb_${Date.now()}_${secureRandomId(4)}`;
    const anonymousAddress = deriveAnonymousAddress(ghostId);

    const mailbox: GhostMailbox = {
      id,
      ghostId,
      anonymousAddress,
      messages: [],
      expiryDate: Date.now() + ttlMs,
    };

    this.mailboxes.set(id, mailbox);

    console.log(
      `[GhostMailbox] Mailbox criada: ${id} (endereço: ${anonymousAddress})`
    );

    return mailbox;
  }

  /**
   * Recebe e armazena uma mensagem criptografada.
   *
   * A mensagem é criptografada com a chave derivada do
   * proprietário da mailbox.
   *
   * @param mailboxId - ID da mailbox
   * @param from - Remetente (pseudônimo)
   * @param body - Corpo em texto plano
   * @returns A mensagem criptografada armazenada
   */
  receive(
    mailboxId: string,
    from: string,
    body: string
  ): MailMessage {
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox) throw new Error(`Mailbox ${mailboxId} não encontrada`);

    // Verificar expiração
    if (Date.now() > mailbox.expiryDate) {
      throw new Error(`Mailbox ${mailboxId} expirada`);
    }

    // Derivar chave e criptografar
    const key = deriveKey(mailbox.ghostId);
    const { ciphertext, nonce } = encryptMessage(body, key);

    const message: MailMessage = {
      id: `msg_${Date.now()}_${secureRandomId(4)}`,
      from,
      bodyEncrypted: ciphertext,
      nonce,
      receivedAt: Date.now(),
      expiresAt: Date.now() + 60 * 60 * 1000, // Mensagens expiram em 1 hora
    };

    mailbox.messages.push(message);

    console.log(
      `[GhostMailbox] Mensagem recebida em ${mailboxId} de "${from}"`
    );

    return message;
  }

  /**
   * Lê e descriptografa uma mensagem.
   *
   * Usa a chave derivada do proprietário para descriptografar.
   *
   * @param mailboxId - ID da mailbox
   * @param messageId - ID da mensagem
   * @returns Texto descriptografado
   */
  read(mailboxId: string, messageId: string): string {
    const mailbox = this.mailboxes.get(mailboxId);
    if (!mailbox) throw new Error(`Mailbox ${mailboxId} não encontrada`);

    const message = mailbox.messages.find((m) => m.id === messageId);
    if (!message) throw new Error(`Mensagem ${messageId} não encontrada`);

    // Verificar expiração da mensagem
    if (Date.now() > message.expiresAt) {
      throw new Error(`Mensagem ${messageId} expirada`);
    }

    // Derivar chave e descriptografar
    const key = deriveKey(mailbox.ghostId);
    const plaintext = decryptMessage(message.bodyEncrypted, message.nonce, key);

    console.log(
      `[GhostMailbox] Mensagem ${messageId} lida de "${message.from}"`
    );

    return plaintext;
  }

  /**
   * Remove mensagens expiradas de todas as mailboxes.
   *
   * Deve ser chamada periodicamente para limpeza.
   *
   * @returns Número de mensagens removidas
   */
  decay(): number {
    let removedCount = 0;
    const now = Date.now();

    for (const [id, mailbox] of this.mailboxes) {
      // Remover mensagens expiradas
      const before = mailbox.messages.length;
      mailbox.messages = mailbox.messages.filter(
        (m) => now <= m.expiresAt
      );
      removedCount += before - mailbox.messages.length;

      // Remover mailbox expirada
      if (now > mailbox.expiryDate && mailbox.messages.length === 0) {
        this.mailboxes.delete(id);
        console.log(`[GhostMailbox] Mailbox ${id} expirada e removida`);
      }
    }

    if (removedCount > 0) {
      console.log(
        `[GhostMailbox] Decay: ${removedCount} mensagens expiradas removidas`
      );
    }

    return removedCount;
  }

  /**
   * Retorna uma mailbox pelo ID.
   */
  getMailbox(mailboxId: string): GhostMailbox | undefined {
    return this.mailboxes.get(mailboxId);
  }

  /**
   * Retorna uma mailbox pelo endereço anônimo.
   */
  getMailboxByAddress(address: string): GhostMailbox | undefined {
    for (const mailbox of this.mailboxes.values()) {
      if (mailbox.anonymousAddress === address) {
        return mailbox;
      }
    }
    return undefined;
  }

  /**
   * Retorna todas as mailboxes ativas.
   */
  getAllMailboxes(): GhostMailbox[] {
    return Array.from(this.mailboxes.values());
  }
}

export const ghostMailboxManager = GhostMailboxManager.getInstance();
