import Dexie, { Table } from 'dexie';
import { UTXO } from '../crypto/utxo';

/**
 * VØID·ΩMEGA — UTXO Database (IndexedDB)
 * 
 * Persistência real dos UTXOs no dispositivo do usuário. Garante que os saldos
 * não se percam quando o browser for fechado ou a aba for recarregada.
 */
export class VoidDatabase extends Dexie {
  utxos!: Table<UTXO, string>;

  constructor() {
    super('VoidHydraDB');
    this.version(1).stores({
      utxos: 'id, amount, spent, createdAt'
    });
  }

  async saveUTXO(utxo: UTXO) {
    await this.utxos.put(utxo);
  }

  async markSpent(ids: string[]) {
    await this.utxos.bulkUpdate(ids.map(id => ({ key: id, changes: { spent: true } })));
  }

  async getUnspentUTXOs(): Promise<UTXO[]> {
    return await this.utxos.filter(utxo => utxo.spent !== true).toArray();
  }

  async getAllUTXOs(): Promise<UTXO[]> {
    return await this.utxos.toArray();
  }
}

export const db = new VoidDatabase();
