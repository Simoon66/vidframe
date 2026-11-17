import { Readable } from 'node:stream';
import { StorageBackendMode } from '../config.ts';

export interface ObjectStat {
  key: string;
  size: number;
  contentType?: string;
}

export interface ObjectStorageAdapter {
  readonly mode: StorageBackendMode;
  readonly isMultiNodeSafe: boolean;
  putObject(key: string, body: Buffer | Readable | string, contentType?: string): Promise<void>;
  putFile(key: string, localFilePath: string, contentType?: string): Promise<void>;
  getObjectStream(key: string, range?: { start: number; end?: number }): Promise<{
    stream: Readable;
    size: number;
    contentType?: string;
  }>;
  getObjectText(key: string): Promise<string>;
  headObject(key: string): Promise<ObjectStat | null>;
  deletePrefix(prefix: string): Promise<number>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}
