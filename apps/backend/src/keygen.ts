import { exportPKCS8, generateKeyPair } from 'jose';

// npm run keygen: a new key for signing org access tokens, as one line for
// ORG_TOKEN_PRIVATE_KEY. Printed here only - put it straight into .env or
// Railway's variables. A new key signs out every member of every organisation
// until their apps fetch a fresh token (within 15 minutes).

const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
console.log((await exportPKCS8(privateKey)).trim().replace(/\n/g, '\\n'));
