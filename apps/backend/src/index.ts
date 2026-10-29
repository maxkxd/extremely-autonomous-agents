import { createServer } from 'node:http';
import { createApp } from './app.js';
import { connect, migrate } from './db.js';
import { createAuth } from './tokens.js';
import { attachRelay } from './relay.js';

// Our backend (docs/architecture.md): sign-in through Clerk, the directory of
// organisations, members, invites and hosts, and the org access tokens hosts
// trust. Settings come from the environment (apps/backend/README.md).

const db = await connect();
await migrate(db);
const auth = await createAuth();
const port = Number(process.env.PORT ?? 5180);
const server = createServer(createApp(db, auth));
// Members' apps reach organisations' hosts through here (relay.ts).
attachRelay(server, db, auth);
server.listen(port, () => console.log(`Backend on http://localhost:${port}`));
