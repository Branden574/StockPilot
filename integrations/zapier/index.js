'use strict';

const { version } = require('./package.json');
const platformVersion = require('zapier-platform-core').version;

const authentication = require('./authentication');
const { addApiKey, handleErrors } = require('./middleware');
const triggers = require('./triggers');
const findItem = require('./searches/findItem');

const App = {
  version,
  platformVersion,

  authentication,

  // Attach the API key to every request; map StockPilot error envelopes.
  beforeRequest: [addApiKey],
  afterResponse: [handleErrors],

  triggers: {
    ...triggers,
  },

  searches: {
    [findItem.key]: findItem,
  },

  // Write "actions" (create PO, adjust stock) land in v1.1 once the public
  // write API + `inventory:write`-scoped endpoints ship — kept intentionally
  // empty here so triggers + search ship first.
  creates: {},
};

module.exports = App;
