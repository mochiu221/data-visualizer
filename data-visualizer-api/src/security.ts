import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { encryptionKey } from './config.js';
import type { Connection } from './models.js';

export function encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decrypt(value: string): string {
    const [iv, tag, data] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function publicConnection(connection: Connection) {
    return { id: connection.id, name: connection.name, type: connection.type, host: connection.host, port: connection.port, database: connection.database, username: connection.username, tls: connection.tls, createdAt: connection.createdAt, status: 'ready' };
}
