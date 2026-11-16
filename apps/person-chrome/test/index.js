// `node --test apps/person-chrome/test/` treats the folder as one module and loads
// this file (see package.json here), so it pulls in every test file.
import './pairing.test.js';
import './relay.test.js';
